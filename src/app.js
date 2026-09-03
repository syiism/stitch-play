// app.js · 串联：状态机内核 + 封闭事件总线 + 四类订阅者 + 播放器
//
// 依赖顺序（单向数据流）：输入事件 → FSM 裁决 → QueueEvent 总线 → 订阅者（UI/预加载/埋点/持久化）只读。

import { QueueEventBus } from "./eventBus.js";
import { QueueFSM } from "./stateMachine.js";
import { PreloadArbiter } from "./preload.js";
import { Tracker } from "./tracker.js";
import { SnapshotWriter } from "./snapshot.js";
import { PlayerController } from "./player.js";
import { UI } from "./ui.js";
import { CollectionWarmer } from "./collWarmup.js";
import { activeSource } from "./sources/index.js";
import { initSources } from "./sources/index.js";
import { loadConfig } from "./runtimeConfig.js";
import { PlaybackHistory } from "./history.js";

function $(id) { return document.getElementById(id); }

async function boot() {
  // 先加载数据源/代理配置并据此注册视频源（config.json；缺失走内置默认）
  const cfg = await loadConfig();
  await initSources(cfg);

  const bus = new QueueEventBus();

  // 内核（当前激活视频源由兼容层注册表决定）
  const fsm = new QueueFSM(bus);

  // 订阅者
  const preload = new PreloadArbiter(bus, fsm);
  const warmer = new CollectionWarmer(bus, fsm); // 预热当前推荐位所属合集（命中缓存即时进入）
  const tracker = new Tracker(bus, { networkType: "wifi" });
  const snapshot = new SnapshotWriter(bus, fsm);
  const history = new PlaybackHistory(bus, fsm); // 播放进度/消费记录（localStorage 持久化）

  // 播放器（DOM 桥接）
  const videoEl = $("video");
  const player = new PlayerController(videoEl, fsm, preload);

  // UI
  const ui = new UI({
    fsm, player, tracker, preload, snapshot, history,
    els: {
      state: $("state"), nowPlaying: $("nowPlaying"),
      btnPlay: $("btnPlay"), btnMute: $("btnMute"),
      btnEnter: $("btnEnter"), btnExit: $("btnExit"),
      btnSwitch: $("btnSwitch"), btnRefresh: $("btnRefresh"),
      btnClearSnap: $("btnClearSnap"), btnRecover: $("btnRecover"),
      netSel: $("netSel"), srcSel: $("srcSel"),
      searchInput: $("searchInput"), btnSearch: $("btnSearch"),
      mainList: $("mainList"), mainPtr: $("mainPtr"),
      collWrap: $("collWrap"), collTitle: $("collTitle"), collList: $("collList"), collPtr: $("collPtr"),
      hisList: $("hisList"),
      preload: $("preload"), metrics: $("metrics"), log: $("log"), toast: $("toast"),
    },
  });

  // 从当前视频源异步拉取主队列并构建模型（远程源失败不阻塞页面）
  try {
    await fsm.init();
  } catch (e) {
    console.error("[App] 主队列加载失败:", e);
    ui.toast(`主队列加载失败：${e.message}`, "err");
  }

  // 冷启动懒恢复（ADR-8）：检测到快照 → 恢复缝合态
  const snap = SnapshotWriter.read();
  if (snap) {
    fsm.recoverCollection(snap);
    ui.toast(`冷启动：已从快照恢复已退出合集（${snap.collectionId}）`, "ok");
  }

  player.init();
  ui.renderAll(); // 主队列就绪后全量重渲染
  ui.toast(`视频源：${activeSource().label}`, "ok");
  ui.toast("自动播放默认静音，点击页面任意处即开启声音", "warn");

  console.info("[App] 播放器队列已启动。状态：", fsm.state, "源：", activeSource().id);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
