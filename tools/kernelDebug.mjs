#!/usr/bin/env node
// kernelDebug.mjs · 内核调试器 CLI（无服务启动；供终端 / Agent 调试播放内核）
//
// 无头运行调度内核（stateMachine 状态机 + queueModel 队列 + eventBus 事件总线 + DeclarativeSource）：
// 不起 server.py、不读 config.json、不依赖浏览器——源定义直接扫描 sources.d/（语义同 server.py），
// 上游地址由 --base 注入直连，或 --proxy 经本地 server.py 转发（UA 兜底）。
// 每步操作后输出：状态、内核快照（双队列/指针/exited 标记/续播位）、本次新增的总线事件。
// stdout 恒为单个 JSON 文档；FSM 的 console.info/warn 走 stderr；exit 0=全部操作成功，1=有失败，2=用法错误。
//
// 用法：
//   node tools/kernelDebug.mjs table                          # 打印内核契约：状态 / 输入 / 转换表 / 事件目录
//   node tools/kernelDebug.mjs list                           # 列出可加载的源
//   node tools/kernelDebug.mjs [选项] <op> [参数] <op> [参数] …   # 顺序执行一串操作
//
// 选项：
//   --source <id|JSON路径>   起始源（默认 sources.d 首个）
//   --base <url>             上游地址（源定义 base 留空时必填；对全部已注册源生效，便于切源联调）
//   --proxy [url]            经本地 server.py 代理转发（默认 http://localhost:8099；校验 UA 的上游需要）
//   --timeout <ms>           上游请求超时（默认 45000）
//
// 操作（op）：
//   init                      拉取主队列并构建模型（ProviderReady）
//   dump | state              打印当前内核快照
//   next | prev               上滑 / 下滑（swipeNext / swipePrev，含已退出合集尾巴路由）
//   ended                     当前集自然播完（playbackEnded：尾巴恢复 > 自动进合集 > 消费前进）
//   enter <colId> [入口]      进合集；入口 = playAll(默认) | autoEnter | history
//   exit                      退出合集（collExit：当前集并回主队列槽位）
//   jump <n>                  手动选集（合集态 / 已退出合集态）
//   index <n>                 主队列定位（宫格点击语义，不消费）
//   progress <cur> <dur>      模拟播放进度（内核写回 + 已退出合集尾巴懒恢复 + ProgressUpdate）
//   resume <videoId>          查询续播位置（getResumePosition）
//   refresh [trigger] [force] 主队列刷新（冷却 / 挂起 / 边界推迟语义）
//   search <kw>               搜索替换主队列（MainQueueReplaced，不持久化）
//   source <id>               切换视频源
//   history <JSON>            resumeHistory：播放记录续播
//   recover <JSON>            recoverCollection：冷启动从快照恢复已退出合集
//   events                    打印累计事件日志
//   wait <ms>                 等待（异步动作沉淀）
//
// 示例：
//   node tools/kernelDebug.mjs --source mufan-short --base http://127.0.0.1:8123 \
//     init ended enter col-710301 playAll jump 2 exit dump

globalThis.localStorage ??= (() => { // 内核链路的 sourcePrefs 依赖浏览器 localStorage；Node 下用内存版兜底
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
})();

const { STATE } = await import("../src/queueModel.js");
const { QueueEventBus, EVENT } = await import("../src/eventBus.js");
const { QueueFSM, INPUT, TABLE } = await import("../src/stateMachine.js");
const { registry } = await import("../src/sources/index.js");
const { DeclarativeSource } = await import("../src/sources/declarativeSource.js");
const { scanSourcesDir, resolveSourceArg, ROOT } = await import("./_sourceLib.mjs");

const usage = (msg) => {
  console.error(`${msg}\n\n用法：node tools/kernelDebug.mjs table | list\n       node tools/kernelDebug.mjs [--source <id|file>] [--base <url>] [--proxy [url]] [--timeout <ms>] <op> …`);
  process.exit(2);
};

// stdout 只承载最终 JSON 文档：本工具与内核的 console.info/log 一律改走 stderr
const emit = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
console.info = (...a) => console.error(...a);
console.log = (...a) => console.error(...a);

// —— 参数解析：先摘全局旗标，余下 token 按顺序消费为 op 序列 ——
const argv = process.argv.slice(2);
const flags = { source: null, base: null, proxy: null, timeout: 45000 };
const tokens = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--source") flags.source = argv[++i];
  else if (a === "--base") flags.base = argv[++i];
  else if (a === "--proxy") flags.proxy = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "http://localhost:8099";
  else if (a === "--timeout") flags.timeout = Number(argv[++i]) || 45000;
  else if (a === "--help" || a === "-h") usage("内核调试器");
  else if (a.startsWith("--")) usage(`未知选项：${a}`);
  else tokens.push(a);
}

// —— 元命令：table（内核契约）/ list ——
if (tokens[0] === "table") {
  emit({
    states: Object.values(STATE),
    inputs: INPUT,
    events: EVENT,
    // 转换表：(state, input) -> action；LOAD_SUCCESS 等内部事件仅在对应状态有效
    table: TABLE,
    note: "表外 (state, input) 组合会被内核丢弃并广播 FallbackTriggered(illegal-transition)。",
  });
  process.exitCode = 0; // 不用 process.exit：管道 stdout 异步刷写，立刻退出会截断输出
}
if (tokens[0] === "list" && tokens.length === 1) {
  emit(scanSourcesDir().map(({ file, def }) => ({
    id: def.id, label: def.label ?? "", file,
    endpoints: def.config?.endpoints ?? {}, hasBase: !!String(def.base || "").trim(),
  })));
  process.exitCode = 0;
}
if (tokens.length === 0) usage("缺少操作序列");

// —— 源装配：全部扫描到的源都按同一 base/proxy 建适配器并注册（switchSource 可用）——
function resolveBase(def) {
  const base = String(flags.base ?? def.base ?? "").trim().replace(/\/+$/, "");
  if (!base) usage(`源「${def.id}」的 base 为空：请用 --base <url> 提供上游地址（--proxy 可经本地 server 转发）`);
  return base;
}
const scanned = scanSourcesDir();
const adapters = new Map();
for (const { def } of scanned) {
  const base = String(flags.base ?? def.base ?? "").trim().replace(/\/+$/, "");
  if (!base) continue; // 未给 base 的源不可用（需 --base）
  adapters.set(def.id, flags.proxy
    ? new DeclarativeSource({ id: def.id, label: def.label, baseUrl: String(flags.proxy).replace(/\/+$/, ""), proxyUpstream: base, config: def.config || {}, timeoutMs: flags.timeout })
    : new DeclarativeSource({ id: def.id, label: def.label, baseUrl: base, config: def.config || {}, timeoutMs: flags.timeout }));
}
// --source 是文件路径（不在 sources.d/ 的草稿）→ 额外注册
let selectedId = flags.source;
if (selectedId && (selectedId.includes("/") || selectedId.endsWith(".json"))) {
  const { file, def } = resolveSourceArg(selectedId, usage);
  const base = resolveBase(def);
  adapters.set(def.id, flags.proxy
    ? new DeclarativeSource({ id: def.id, label: def.label, baseUrl: String(flags.proxy).replace(/\/+$/, ""), proxyUpstream: base, config: def.config || {}, timeoutMs: flags.timeout })
    : new DeclarativeSource({ id: def.id, label: def.label, baseUrl: base, config: def.config || {}, timeoutMs: flags.timeout }));
  selectedId = def.id;
  var draftFile = file;
}
if (adapters.size === 0) usage("没有任何可用源：sources.d/ 为空或未提供 --base");
for (const a of adapters.values()) registry.register(a);
if (!selectedId) selectedId = adapters.keys().next().value;
const source = adapters.get(selectedId);
if (!source) usage(`源「${selectedId}」不可用（无 base 或不在 sources.d/）：可用 ${[...adapters.keys()].join("、")}`);

// —— 内核 + 事件记录 ——
const bus = new QueueEventBus();
const eventLog = [];
let seq = 0;
for (const type of Object.values(EVENT)) {
  bus.on(type, (payload) => eventLog.push({ seq: ++seq, time: new Date().toISOString(), type, ...payload }));
}
const fsm = new QueueFSM(bus, source);

// —— 快照（面向 agent 的内核可观察态；标题经源元数据富化）——
function snapshot() {
  const m = fsm.model;
  const metaOf = (vid) => source.getVideoMeta?.(vid) || null;
  const itemOut = (it, extra = {}) => ({
    videoId: it.videoId, state: it.state, progressSec: it.progressSec, durationSec: it.durationSec,
    title: extra.title ?? metaOf(it.videoId)?.title ?? null,
    collectionId: extra.collectionId ?? metaOf(it.videoId)?.collectionId ?? null,
    episodeIndex: metaOf(it.videoId)?.episodeIndex ?? null,
  });
  const seed = m.mainQueue.seed || [];
  const cur = m.currentVideoId();
  return {
    state: m.state,
    currentVideoId: cur,
    resumeSec: cur ? fsm.getResumePosition(cur) : 0,
    can: { swipeNext: fsm.canSwipeNext(), swipePrev: fsm.canSwipePrev(), jumpEpisode: fsm.canJumpEpisode() },
    entrySource: fsm._entrySource,
    collPlayedCount: fsm._collPlayedCount,
    main: {
      pointer: m.mainQueue.pointer, length: m.mainQueue.items.length,
      items: m.mainQueue.items.map((it, i) => itemOut(it, { title: seed[i]?.title ?? null, collectionId: seed[i]?.collectionId ?? null })),
    },
    collection: m.collectionQueue ? {
      collectionId: m.collectionQueue.collectionId,
      pointer: m.collectionQueue.pointer, length: m.collectionQueue.items.length,
      exited: m.collectionQueue.exited, tailLazy: m.collectionQueue.tailLazy,
      replacedIndex: m.collectionQueue.replacedIndex, tailLength: m.exitedTailLength(),
      items: m.collectionQueue.items.map((it) => itemOut(it)),
    } : null,
  };
}

// —— 异步沉淀：等事件流静默（合集加载重试 / Fallback 恢复 / 尾巴懒恢复都是延时回调）——
async function quiesce(idleMs = 250, maxMs = 5000) {
  const t0 = Date.now();
  let last = eventLog.length, lastChange = Date.now();
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 50));
    if (eventLog.length !== last) { last = eventLog.length; lastChange = Date.now(); continue; }
    if (Date.now() - lastChange >= idleMs) break;
  }
}

// —— op 装配：顺序消费 token ——
const ENTRY_SET = new Set(["playAll", "autoEnter", "history"]);
const take = () => { const t = tokens.shift(); if (t === undefined) usage("操作参数不足"); return t; };
const peekIs = (...set) => set.includes(tokens[0]);
const OPS = {
  init: async () => { await fsm.init(); return true; },
  dump: () => true, state: () => true,
  next: () => fsm.swipeNext(), prev: () => fsm.swipePrev(),
  ended: () => fsm.playbackEnded(), exit: () => fsm.exitCollection(),
  enter: () => { const colId = take(); const entry = peekIs(...ENTRY_SET) ? tokens.shift() : "playAll"; fsm.enterCollection(colId, entry); return true; },
  jump: () => { const i = Number(take()); if (!Number.isInteger(i)) usage("jump 需要整数下标"); return fsm.jumpToEpisode(i); },
  index: () => { const i = Number(take()); if (!Number.isInteger(i)) usage("index 需要整数下标"); return fsm.switchToMainIndex(i); },
  progress: () => { const c = Number(take()), d = Number(take()); fsm.onProgress(c, d, d - c, d ? c / d : 0); return true; },
  resume: () => ({ resumeSec: fsm.getResumePosition(take()) }),
  refresh: () => { const trigger = (tokens.length && !peekIs("force")) ? tokens.shift() : "manual"; const force = peekIs("force") ? tokens.shift() : null; fsm.requestRefresh(trigger, { force: !!force }); return true; },
  search: async () => fsm.search(take()),
  source: async () => { const r = await fsm.switchSource(take()); return !!r.ok; },
  history: async () => { const r = await fsm.resumeHistory(JSON.parse(take())); return !!r.ok; },
  recover: () => { fsm.recoverCollection(JSON.parse(take())); return true; },
  wait: async () => { await new Promise((r) => setTimeout(r, Number(take()) || 100)); return true; },
  events: () => true,
};

// —— 顺序执行 ——
const results = [];
let allOk = true;
while (tokens.length) {
  const name = tokens.shift();
  const fn = OPS[name];
  if (!fn) usage(`未知操作「${name}」：可用 ${Object.keys(OPS).join(" / ")}`);
  const evStart = eventLog.length;
  let ok = true, ret = undefined, error = null;
  try { ret = await fn(); } catch (e) { ok = false; error = e.message || String(e); }
  if (ret === false) ok = false;
  await quiesce();
  const newEvents = eventLog.slice(evStart);
  results.push({
    op: name, ok, ...(ret !== undefined && !(ret instanceof Object) ? { ret } : {}),
    ...(ret && typeof ret === "object" ? ret : {}),
    ...(error ? { error } : {}),
    events: newEvents,
    snapshot: snapshot(),
  });
  if (!ok) allOk = false;
}

emit({
  tool: "kernelDebug",
  source: selectedId,
  ...(draftFile ? { draftFile } : {}),
  transport: flags.proxy ? `proxy → ${flags.proxy}` : "direct",
  ok: allOk,
  ops: results,
  finalSnapshot: snapshot(),
  events: eventLog,
});
// 设 exitCode 而非 process.exit：让异步的管道 stdout 排空后再自然退出（否则 JSON 被截断）
process.exitCode = allOk ? 0 : 1;
