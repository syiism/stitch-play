#!/usr/bin/env node
// sourceDebug.mjs · 视频源调试器 CLI（供终端 / Agent 调试声明式源）
//
// 复用 src/sources/declarativeSource.js 的 debugProbe（实发请求，未剥信封原始响应）
// 与 debugEvaluate（只读映射求值），请求拼装/信封剥离/占位符语义与线上完全一致；
// 源定义扫描与 tools/server.py _scan_sources_dir 同语义（文件名排序、真实文件覆盖同名 example）。
//
// 用法：
//   node tools/sourceDebug.mjs list
//   node tools/sourceDebug.mjs <源id|源JSON路径> <discover|search|directory|video> [参数] [选项]
//
// 命令：
//   list                                    列出可调试的源
//   <源> discover                           探测发现流（endpoints.discover + params.discover）
//   <源> search <关键词>                    探测搜索（{keyword} 占位注入 / key= 回落）
//   <源> directory <collectionId|book_id>   探测合集目录（自动剥 col- 前缀）
//   <源> video <item_id> [--book <book_id>] 探测取流（自动剥 ep- 前缀；mapping.src 求值）
//
// 选项：
//   --base <url>     上游地址（默认取源定义 base；留空的源必填，仓库内源一律留空）
//   --proxy [url]    经本地 server.py 同源代理转发（默认 http://localhost:8099；
//                    兔兔等强制校验浏览器 UA 的上游必须走此模式，server 会兜底 UA）
//   --e2e            走适配器完整流程（listMainQueue / search / listCollection / resolveSrc，
//                    含缓存与去重语义，输出归一化 QueueItem；resolveSrc 传 videoId）
//   --raw            输出包含未剥信封的原始响应（默认只给请求行 + 求值摘要）
//   --save <file>    把原始响应写入文件（可粘贴进规则工坊演练场）
//   --timeout <ms>   请求超时（默认 45000）
//
// 输出：单个 JSON（stdout）。exit 0 = 成功，1 = 请求/求值失败，2 = 用法错误。

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DeclarativeSource } from "../src/sources/declarativeSource.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES_DIR = join(ROOT, "sources.d");
const DEFAULT_SERVER = "http://localhost:8099";

const usage = (msg) => {
  console.error(`${msg}\n\n用法：node tools/sourceDebug.mjs list\n       node tools/sourceDebug.mjs <源id|源JSON路径> <discover|search|directory|video> [参数] [--base <url>] [--proxy [url]] [--e2e] [--raw] [--save <file>] [--timeout <ms>]`);
  process.exit(2);
};

// —— 源定义加载（与 server.py _scan_sources_dir 同语义）——
function scanSourcesDir() {
  let chosen = {};
  try {
    for (const fn of readdirSync(SOURCES_DIR).sort()) {
      if (!fn.endsWith(".json")) continue;
      const isExample = fn.endsWith(".example.json");
      const base = isExample ? fn.slice(0, -".example.json".length) : fn.slice(0, -".json".length);
      if (!(base in chosen) || !isExample) chosen[base] = join(SOURCES_DIR, fn); // 真实文件覆盖同名 example
    }
  } catch {
    return []; // 目录缺失
  }
  const out = [];
  for (const p of Object.values(chosen)) {
    try {
      const s = JSON.parse(readFileSync(p, "utf-8"));
      if (s && typeof s === "object" && typeof s.id === "string" && s.id) out.push({ file: p, def: s });
    } catch { /* 解析失败的文件跳过，与 server 行为一致 */ }
  }
  return out;
}

function resolveSourceArg(arg) {
  if (arg.includes("/") || arg.endsWith(".json")) {
    const file = resolve(arg);
    const def = JSON.parse(readFileSync(file, "utf-8"));
    if (!def || typeof def !== "object" || typeof def.id !== "string" || !def.id) {
      usage(`源定义 ${file} 缺少有效 id 字段`);
    }
    return { file, def };
  }
  const hit = scanSourcesDir().find((s) => s.def.id === arg);
  if (!hit) usage(`未找到源「${arg}」：可先运行 node tools/sourceDebug.mjs list 查看可用源（或直接传源 JSON 文件路径）`);
  return hit;
}

function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") opts.base = argv[++i];
    else if (a === "--book") opts.book = argv[++i];
    else if (a === "--proxy") opts.proxy = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : DEFAULT_SERVER;
    else if (a === "--e2e") opts.e2e = true;
    else if (a === "--raw") opts.raw = true;
    else if (a === "--save") opts.save = argv[++i];
    else if (a === "--timeout") opts.timeout = Number(argv[++i]) || 45000;
    else if (a.startsWith("--")) usage(`未知选项：${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

// 与 declarativeSource._get / 演练场 envelopeStrip 一致的信封剥离（debugEvaluate 的求值上下文）
function envelopeStrip(json) {
  if (json && typeof json === "object" && !Array.isArray(json) && json.data !== undefined) return json.data;
  return json;
}

function buildAdapter(def, opts) {
  const upstream = String(opts.base ?? def.base ?? "").trim().replace(/\/+$/, "");
  if (!upstream) {
    usage(`源「${def.id}」的 base 为空（仓库内源一律如此）：请用 --base <url> 提供上游地址\n` +
          `  直连：--base https://…\n  走本地 server 代理（UA 兜底）：--base https://… --proxy`);
  }
  if (opts.proxy) {
    const server = String(opts.proxy).replace(/\/+$/, "");
    return { adapter: newProxySource(def, server, upstream, opts), transport: `proxy ${upstream} → ${server}`, upstream };
  }
  return { adapter: newSource(def, upstream, null, opts), transport: `direct ${upstream}`, upstream };
}

function newSource(def, baseUrl, proxyUpstream, opts) {
  return new DeclarativeSource({
    id: def.id, label: def.label, baseUrl, proxyUpstream,
    config: def.config || {}, timeoutMs: opts.timeout,
  });
}
function newProxySource(def, server, upstream, opts) {
  // 与浏览器代理模式同构：请求发 server 根路径，上游经 ?proxy_upstream= 交给 server.py 转发（含 UA 兜底）
  return newSource(def, server, upstream, opts);
}

// —— 输出摘要（面向 agent：默认紧凑，--raw 才带原始响应）——
function compactEval(kind, ev) {
  if (ev.kind === "discover" || ev.kind === "search") {
    if (!ev.listHit) return { listHit: false, hint: "mapping.items 未命中数组：检查信封层级与 [*] 通配" };
    const miss = {};
    for (const f of ["videoId", "title", "poster", "collectionId", "category"]) {
      const n = ev.items.filter((it) => it.fields[f] == null || it.fields[f] === "").length;
      if (n) miss[f] = n;
    }
    return { listHit: true, count: ev.count, items: ev.items.map((it) => it.fields), ...(Object.keys(miss).length ? { fieldMisses: miss } : {}) };
  }
  if (ev.kind === "directory") {
    return ev.count > 0
      ? { count: ev.count, episodes: ev.items.map((e) => ({ index: e.index, itemId: e.itemId, title: e.title })) }
      : { count: 0, hint: "目录为空：检查 collectionItemsPath 与响应结构" };
  }
  if (ev.kind === "video") {
    return ev.src
      ? { src: ev.proxied || ev.src, ...(ev.proxied && ev.proxied !== ev.src ? { rawSrc: ev.src } : {}) }
      : { src: null, hint: "未取到播放地址：检查 mapping.src（或缺省回落 data.url / data.video_url）" };
  }
  return ev;
}

function compactItems(items) {
  return items.map((it) => ({
    videoId: it.videoId, title: it.title, collectionId: it.collectionId ?? null,
    poster: it.poster ?? null, duration: it.duration ?? null, category: it.category ?? null,
  }));
}

// —— 主流程 ——
const [srcArg, cmd, ...rest] = process.argv.slice(2);
if (!srcArg || srcArg === "--help" || srcArg === "-h") usage("缺少源参数");
const opts = parseArgs(rest);

if (srcArg === "list") {
  const list = scanSourcesDir().map(({ file, def }) => ({
    id: def.id, label: def.label ?? "", category: def.category ?? "", file,
    endpoints: def.config?.endpoints ?? {},
    hasBase: !!String(def.base || "").trim(),
  }));
  console.log(JSON.stringify(list, null, 2));
  process.exit(0);
}

const KINDS = { discover: 1, search: 1, directory: 1, video: 1 };
if (!KINDS[cmd]) usage(`未知命令「${cmd ?? ""}」：应为 discover | search | directory | video`);
const arg = opts.positional[0];

let ctx = {};
if (cmd === "search") { if (!arg) usage("search 需要 <关键词>"); ctx.keyword = arg; }
if (cmd === "directory") { if (!arg) usage("directory 需要 <collectionId|book_id>"); ctx.book_id = arg; }
if (cmd === "video") { if (!arg) usage("video 需要 <item_id>（e2e 模式传 videoId，如 ep-456 / drama-123）"); ctx.item_id = arg; if (opts.book) ctx.book_id = opts.book; }

const { file, def } = resolveSourceArg(srcArg);
const { adapter, transport } = buildAdapter(def, opts);

const result = { source: def.id, file, command: cmd, transport, ok: false };

try {
  if (opts.e2e) {
    // 端到端：直调适配器公共契约方法（含缓存/去重/懒解析语义）
    result.e2e = true;
    if (cmd === "discover") result.items = compactItems(await adapter.listMainQueue());
    else if (cmd === "search") result.items = compactItems(await adapter.search(ctx.keyword));
    else if (cmd === "directory") {
      const r = await adapter.listCollection(ctx.book_id);
      result.collection = { collectionId: r.collectionId, title: r.title, count: r.items.length, startPointer: r.startPointer };
      result.items = compactItems(r.items.slice(0, 30));
    } else {
      result.src = await adapter.resolveSrc(ctx.item_id) ?? null;
      if (!result.src) result.hint = "resolveSrc → null：原因见该源上游响应与 mapping.src";
    }
    result.ok = cmd === "video" ? !!result.src : (cmd === "discover" ? result.items.length > 0 : true);
  } else {
    const r = await adapter.debugProbe(cmd, ctx);
    result.request = { url: r.url, status: r.status ?? null, ms: r.ms ?? null };
    if (!r.ok) {
      result.error = r.error || "请求失败";
    } else {
      const ev = compactEval(cmd, adapter.debugEvaluate(cmd, envelopeStrip(r.raw)));
      result.evaluation = ev;
      if (opts.raw) result.raw = r.raw;
      if (opts.save) {
        writeFileSync(opts.save, JSON.stringify(r.raw, null, 2) + "\n");
        result.savedTo = opts.save;
      }
      // 退出码反映「源是否健康」：请求成功且映射求值有产出才算 ok。
      // 例外：search 命中列表但 0 结果是合法业务态（上游确实没有），不算源故障。
      const healthy = cmd === "search" ? ev.listHit !== false
        : cmd === "video" ? !!ev.src
        : cmd === "discover" ? !!(ev.listHit && ev.count > 0)
        : (ev.count ?? 0) > 0; // directory
      result.ok = healthy;
      if (!healthy) result.hint = "映射求值无产出：源定义规则与该响应不匹配（对照 evaluation 定位）";
    }
  }
} catch (e) {
  result.error = e.message || String(e);
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
