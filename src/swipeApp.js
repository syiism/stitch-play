// swipeApp.js · 竖屏滑动播放器的装配入口
//
// 数据流：输入事件 → FSM 裁决 → QueueEvent 总线 → 只读订阅者。

import { QueueEventBus } from "./eventBus.js";
import { QueueFSM } from "./stateMachine.js";
import { PreloadArbiter } from "./preload.js";
import { Tracker } from "./tracker.js";
import { SnapshotWriter } from "./snapshot.js";
import { PlayerController } from "./player.js";
import { SwipeUI } from "./swipeUi.js";
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

  // 订阅者（零侵入，只读总线）
  const preload = new PreloadArbiter(bus, fsm);
  const warmer = new CollectionWarmer(bus, fsm); // 预热当前推荐位所属合集（命中缓存即时进入）
  const tracker = new Tracker(bus, { networkType: "wifi" });
  const snapshot = new SnapshotWriter(bus, fsm);
  const history = new PlaybackHistory(bus, fsm); // 播放进度/消费记录（localStorage 持久化）

  // 播放器（DOM 桥接：订阅 StateChanged → 按 currentVideoId 加载并播放）
  const player = new PlayerController($("video"), fsm, preload);

  // 竖屏滑动 UI
  const ui = new SwipeUI({
    fsm, player, tracker, preload, snapshot, history,
    els: {
      stage: $("stage"), deck: $("deck"), video: $("video"),
      loader: $("loader"), bigPlay: $("bigPlay"),
      state: $("state"), srcSel: $("srcSel"),
      btnPlay: $("btnPlay"), btnMute: $("btnMute"), btnColl: $("btnColl"), btnExit: $("btnExit"),
      btnRate: $("btnRate"),
      volRange: $("volRange"), sideVol: $("sideVol"),
      btnFs: $("btnFs"), btnView: $("btnView"), btnViewClose: $("btnViewClose"), view: $("view"), grid: $("grid"),
      btnClean: $("btnClean"), btnCleanExit: $("btnCleanExit"),
      btnEps: $("btnEps"), epPanel: $("epPanel"), epMask: $("epMask"),
      epList: $("epList"), epTitle: $("epTitle"), btnEpsClose: $("btnEpsClose"),
      btnSearch: $("btnSearch"), searchPanel: $("searchPanel"), btnSearchClose: $("btnSearchClose"),
      searchInput: $("searchInput"), btnSearchGo: $("btnSearchGo"), searchSrcLabel: $("searchSrcLabel"),
      btnHistory: $("btnHistory"), hisPanel: $("hisPanel"), btnHisClose: $("btnHisClose"), btnHisClear: $("btnHisClear"), hisList: $("hisList"),
      btnMore: $("btnMore"), topMore: $("topMore"),
      srcBaseInput: $("srcBaseInput"), srcBaseSave: $("srcBaseSave"), srcProxy: $("srcProxy"),
      btnPanel: $("btnPanel"), btnPanelClose: $("btnPanelClose"), panel: $("panel"),
      cat: $("cat"), title: $("title"), sub: $("sub"), barFill: $("barFill"), tip: $("tip"),
      rail: $("rail"), hintSwipe: $("hintSwipe"), toast: $("toast"),
      pState: $("pState"), pMain: $("pMain"), pColl: $("pColl"),
      pPre: $("pPre"), pMetrics: $("pMetrics"), pLog: $("pLog"),
      cfgPreloadEnabled: $("cfgPreloadEnabled"), cfgTriggerRemainingSec: $("cfgTriggerRemainingSec"),
      cfgTriggerRatio: $("cfgTriggerRatio"), cfgMinSinceStartSec: $("cfgMinSinceStartSec"),
      cfgPreloadBytesL2: $("cfgPreloadBytesL2"), cfgPreloadBytesL3: $("cfgPreloadBytesL3"),
      cfgReset: $("cfgReset"),
    },
  });

  // 从当前视频源异步拉取主队列并构建模型
  try {
    await fsm.init();
  } catch (e) {
    console.error("[SwipeApp] 主队列加载失败:", e);
    ui.toast(`主队列加载失败：${e.message}`, "err");
  }

  // 冷启动懒恢复（ADR-8）
  const snap = SnapshotWriter.read();
  if (snap) {
    fsm.recoverCollection(snap);
    ui.toast(`冷启动：已恢复已退出合集（${snap.collectionId}）`, "ok");
  }

  player.init();
  ui.renderAll();
  ui.toast(`视频源：${activeSource().label} · 上滑/下滑切换`, "ok");

  console.info("[SwipeApp] 竖屏滑动播放器已启动。状态：", fsm.state, "源：", activeSource().id);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();

function start() {
  // boot() 里任一环节抛错都会导致 SwipeUI 从未构造 —— 表现为「所有按钮点了没反应」。
  // 这里必须把失败暴露到界面，避免静默失效难以定位。
  boot().catch((e) => {
    console.error("[SwipeApp] 启动失败:", e);
    const host = $("toast");
    if (!host) return;
    const el = document.createElement("div");
    el.className = "toast err";
    el.textContent = `启动失败：${e.message}`;
    host.appendChild(el);
  });
}
