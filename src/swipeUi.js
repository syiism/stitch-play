// swipeUi.js · 竖屏滑动 UI（重构版：缝合态融入合集队列）
//
// 变更：删除 STATE.STITCH 引用与 STITCH_* 事件；
// 已退出合集的 UI 语义统一为 MAIN_QUEUE 态下的特殊显示。

import { EVENT } from "./eventBus.js";
import { STATE } from "./queueModel.js";
import { CONFIG } from "./config.js";
import { activeSource, listSources, registry, getBaseUrl, getProxy, setSourceBase, episodeDisplayTitle } from "./sources/index.js";

const STATE_LABEL = {
  [STATE.MAIN_QUEUE]: "推荐流",
  [STATE.LOAD_COLLECTION]: "加载合集…",
  [STATE.COLLECTION_QUEUE]: "合集连播",
  [STATE.FALLBACK]: "降级回推荐",
};

const GESTURE = {
  minDistance: 60,
  flickDistance: 28,
  flickMs: 260,
  axisDead: 6,
  tapMaxMs: 400,
  tapMaxMove: 10,
  wheelLockMs: 450,
  wheelThreshold: 30,
  railWindow: 14,
  longPressMs: 500, // 左右方向键长按判定阈值（按住 ≥ 500ms 视为长按）
};

export class SwipeUI {
  constructor({ fsm, player, tracker, preload, snapshot, history, els }) {
    this.fsm = fsm; this.player = player; this.tracker = tracker;
    this.preload = preload; this.snapshot = snapshot; this.history = history || null; this.els = els;
    this._busy = false;
    this._wheelLockUntil = 0;
    this._panelStack = []; // 面板打开栈（ESC 按后打开优先关闭）

    this._subscribe();
    this._bindControls();
    this._bindMedia();
    this._bindGestures();
    this._bindConfig();
    this.populateSources();
    this.renderAll();
    this.renderMetrics(tracker.metrics());
    this._syncFsIcon();
  }

  _subscribe() {
    const b = this.fsm.bus;
    const R = () => this.renderAll();
    b.on(EVENT.STATE_CHANGED, (p) => { R(); this.log("StateChanged", p); });
    b.on(EVENT.ITEM_CONSUMED, (p) => { this.renderRail(); this.log("ItemConsumed", p); });
    b.on(EVENT.COLLECTION_ENTERED, (p) => { R(); this.log("CollectionEntered", p); });
    b.on(EVENT.COLLECTION_EXITED, (p) => {
      R(); this.log("CollectionExited", p, p.exitType === "autoFinish" ? "ok" : "");
      if (p.exitType === "autoFinish") this.toast("本剧已看完，回到推荐流", "ok");
      else if (p.exitType === "detach") this.toast("已退出合集，当前集继续播放", "ok");
    });
    b.on(EVENT.MAIN_QUEUE_REPLACED, (p) => { R(); this.log("MainQueueReplaced", p); });
    b.on(EVENT.MAIN_QUEUE_REFRESHED, (p) => { R(); this.log("MainQueueRefreshed", p, p.dropped ? "err" : "ok"); });
    b.on(EVENT.FALLBACK_TRIGGERED, (p) => { R(); this.log("FallbackTriggered", p, "err"); this.toast(`降级：${p.scene}/${p.reason}`, "err"); });
    b.on(EVENT.PRELOAD_STAGE, (p) => this.renderPanel());
    b.on(EVENT.PROVIDER_READY, (p) => { R(); this.log("ProviderReady", p, p.switched ? "ok" : ""); });
    this.tracker.onFlush = (batch, metrics) => this.renderMetrics(metrics);
  }

  _bindControls() {
    const e = this.els;
    e.btnMore.onclick = () => this._toggleMore();
    document.addEventListener("pointerdown", (ev) => {
      if (this.els.topMore.classList.contains("on") &&
          !ev.target.closest("#topMore") && !ev.target.closest("#btnMore")) this._toggleMore(false);
    });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") this._onEscape(); });
    e.btnPlay.onclick = () => { this.player.togglePlay(); this.renderPlayBtn(); };
    this._renderMute(false);
    this.player.onMuteChange = (muted) => this._renderMute(!muted);
    this.player.onVolumeChange = (level, muted) => this._renderVolume(level, muted);
    this.player.onPlaybackRateChange = (rate) => this._renderRate(rate);
    this._renderRate(this.player.getPlaybackRate());
    e.btnRate.onclick = () => {
      const rate = this.player.cyclePlaybackRate();
      this._renderRate(rate);
      this.toast(`播放倍速：${parseFloat(rate)}×`, "ok");
    };
    const coarse = window.matchMedia ? window.matchMedia("(hover: none)").matches : false;
    e.btnMute.onclick = () => {
      if (coarse) {
        const open = !this.els.sideVol.classList.contains("open");
        this._toggleVol(open);
        if (open) this.toast("上下拖动滑杆调节音量", "ok");
        return;
      }
      const on = this.player.toggleMute();
      this._renderMute(on);
      if (this.els.volRange) this.els.volRange.value = String(this.player.getVolume());
      this._toggleVol(true);
      this.toast(on ? "声音已开启" : "已静音", "ok");
    };
    if (e.volRange) {
      const applyVol = () => {
        const level = this.player.setVolume(parseFloat(e.volRange.value));
        this._renderVolume(level, this.player.video?.muted ?? false);
      };
      e.volRange.addEventListener("input", applyVol);
      e.volRange.addEventListener("change", applyVol);
    }
    document.addEventListener("pointerdown", (ev) => {
      if (this.els.sideVol.classList.contains("open") &&
          !ev.target.closest("#sideVol")) this._toggleVol(false);
    });
    if (!coarse) {
      e.sideVol.addEventListener("mouseenter", () => this._toggleVol(true));
      e.sideVol.addEventListener("mouseleave", () => this._toggleVol(false));
    }
    e.btnColl.onclick = () => {
      const cq = this.fsm.model.collectionQueue;
      // 已退出合集 → 重入
      if (cq?.exited) {
        this.fsm.enterCollection(cq.collectionId, "reenter");
        return;
      }
      const seed = this.fsm.model.mainQueue.seed[this.fsm.model.mainQueue.pointer];
      if (seed?.collectionId) this.fsm.enterCollection(seed.collectionId, "playAll");
    };
    e.btnEps.onclick = () => this.toggleEpisodes(true);
    e.btnEpsClose.onclick = () => this.toggleEpisodes(false);
    e.epMask.onclick = () => this.toggleEpisodes(false);
    e.epList.onclick = (ev) => {
      const li = ev.target.closest("[data-idx]");
      if (!li) return;
      const idx = parseInt(li.dataset.idx, 10);
      const m = this.fsm.model;
      const prevIdx = m.collectionQueue ? m.collectionQueue.pointer : -1;
      if (!this.fsm.jumpToEpisode(idx)) { this.toast("当前状态不可跳转", "warn"); return; }
      this.toggleEpisodes(false);
      this.renderAll();
      this._animate(idx > prevIdx ? -1 : 1);
      this.toast(`已跳到第 ${idx + 1} 集`, "ok");
    };
    // 退出按钮：单步完全脱离合集，当前正在播放的集并入主队列继续播放
    e.btnExit.onclick = () => {
      if (this.fsm.state === STATE.COLLECTION_QUEUE) this.fsm.exitCollection();
    };
    e.btnPanel.onclick = () => this._togglePanel();
    e.btnPanelClose.onclick = () => this._togglePanel(false);
    e.btnHelpClose.onclick = () => this.toggleHelp(false);
    e.helpMask.onclick = () => this.toggleHelp(false);
    e.btnSearch.onclick = () => this.toggleSearch(true);
    e.btnSearchClose.onclick = () => this.toggleSearch(false);
    e.btnSearchGo.onclick = () => this._doSearch();
    e.searchInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") this._doSearch(); });
    e.srcSel.onchange = () => {
      const id = e.srcSel.value;
      this._loadBaseInput(id);
      this.toast("切换源中…", "warn");
      this.fsm.switchSource(id).then((r) => {
        const rg = r && typeof r === "object" ? r : { ok: !!r };
        if (rg.ok) {
          this.toast(
            rg.failed ? `已切换：${activeSource().label}（主队列加载失败）` : `已切换：${activeSource().label}`,
            rg.failed ? "warn" : "ok",
          );
        } else if (!rg.stale) {
          this.populateSources();
          const label = registry.get(id)?.label || id;
          this.toast(`未知视频源：${label}`, "err");
        }
      });
    };
    e.srcBaseSave.onclick = () => this._saveSrcBase();
    e.srcProxy.onchange = () => this._saveSrcBase();
    e.btnFs.onclick = () => this.toggleFullscreen();
    document.addEventListener("fullscreenchange", () => this._syncFsIcon());
    e.btnClean.onclick = () => this.toggleClean();
    e.btnCleanExit.onclick = () => this.toggleClean(false);
    e.btnView.onclick = () => this.toggleView();
    e.btnViewClose.onclick = () => this.toggleView(false);
    e.btnHistory.onclick = () => this.toggleHistory(true);
    e.btnHisClose.onclick = () => this.toggleHistory(false);
    e.btnHisClear.onclick = () => this._clearHistory();
    e.hisList.onclick = (ev) => {
      const del = ev.target.closest("[data-del]");
      if (del) { this._deleteHistory(del.dataset.del); return; }
      const li = ev.target.closest("[data-vid]");
      if (!li) return;
      this._resumeHistory(li.dataset.vid);
    };
  }

  // ============ 全屏（桌面/移动）：进入/退出都解锁方向，允许横竖屏自由切换 ============
  toggleFullscreen() {
    const el = this.els.stage;
    const unlock = () => {
      try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch { }
    };
    if (document.fullscreenElement) { unlock(); document.exitFullscreen(); }
    else if (el.requestFullscreen) { unlock(); el.requestFullscreen(); }
  }

  _syncFsIcon() {
    const on = !!document.fullscreenElement;
    this.els.btnFs.innerHTML = `<svg class="ic"><use href="#${on ? "i-fs-exit" : "i-fs-enter"}"/></svg>`;
    this.els.btnFs.title = on ? "退出全屏" : "全屏";
  }

  toggleClean(force) {
    const on = force !== undefined ? !!force : !this.els.stage.classList.contains("clean");
    this.els.stage.classList.toggle("clean", on);
    if (on) this.els.stage.classList.remove("ui-revealed");
    this.els.btnClean.innerHTML = `<svg class="ic"><use href="#${on ? "i-clean-off" : "i-clean"}"/></svg>`;
    this.els.btnClean.title = on ? "退出清屏" : "清屏 · 沉浸式追剧";
    this.toast(on ? "已进入沉浸模式（点上方可退出清屏）" : "已退出清屏", "ok");
  }

  _toggleMore(force) {
    const on = force !== undefined ? !!force : !this.els.topMore.classList.contains("on");
    this.els.topMore.classList.toggle("on", on);
    if (on) this._openPanel("topMore", () => this._toggleMore(false));
    else this._closePanel("topMore");
  }

  // ============ 面板打开栈（ESC 逐层关闭：后打开优先，合集退出兜底栈底）============
  /** 打开面板：记录关闭回调（同 id 先移除旧项，保证仅一份） */
  _openPanel(id, closeFn) {
    this._closePanel(id);
    this._panelStack.push({ id, close: closeFn });
  }
  /** 关闭面板：从栈中移除其关闭回调（不执行） */
  _closePanel(id) {
    const i = this._panelStack.findIndex((p) => p.id === id);
    if (i >= 0) this._panelStack.splice(i, 1);
  }
  /** ESC 统一入口：面板栈后打开先关；全部关完且处于合集态 → 退出合集（等效栈底兜底） */
  _onEscape() {
    if (this._panelStack.length > 0) {
      const top = this._panelStack.pop();
      top.close();
      return;
    }
    // 栈空：合集态按 ESC = 退出合集（当前集并入主队列续播）
    if (this.fsm.state === STATE.COLLECTION_QUEUE) {
      this.fsm.exitCollection();
    }
  }

  toggleView(force) {
    const on = force !== undefined ? !!force : !this.els.view.classList.contains("on");
    this.els.view.classList.toggle("on", on);
    this.els.btnView.innerHTML = on
      ? `<svg class="ic"><use href="#i-play"/></svg><span>滑动</span>`
      : `<svg class="ic"><use href="#i-grid"/></svg><span>宫格</span>`;
    this.els.btnView.title = on ? "回到滑动播放" : "宫格浏览";
    if (on) {
      this.renderGrid();
      this._openPanel("view", () => this.toggleView(false));
    } else {
      this._closePanel("view");
    }
  }

  /** 调试面板开关（ESC 纳入面板栈） */
  _togglePanel(force) {
    const on = force !== undefined ? !!force : !this.els.panel.classList.contains("on");
    this.els.panel.classList.toggle("on", on);
    if (on) this._openPanel("panel", () => this._togglePanel(false));
    else this._closePanel("panel");
  }

  /** 快捷键帮助（屏幕中央悬浮；h/H 键或点遮罩开关，纳入 ESC 面板栈） */
  toggleHelp(force) {
    const on = force !== undefined ? !!force : !this.els.helpPanel.classList.contains("on");
    this.els.helpPanel.classList.toggle("on", on);
    this.els.helpMask.classList.toggle("on", on);
    if (on) this._openPanel("help", () => this.toggleHelp(false));
    else this._closePanel("help");
  }

  /** f/F 键：进入合集（与「进入合集」按钮同语义：已退出合集 → 重入；当前推荐带合集 → 连播） */
  _enterCollectionByKey() {
    const cq = this.fsm.model.collectionQueue;
    if (cq?.exited) {
      this.fsm.enterCollection(cq.collectionId, "reenter");
      return;
    }
    if (this.fsm.state !== STATE.MAIN_QUEUE) { this.toast("当前状态不可进入合集", "warn"); return; }
    const seed = this.fsm.model.mainQueue.seed[this.fsm.model.mainQueue.pointer];
    if (seed?.collectionId) this.fsm.enterCollection(seed.collectionId, "playAll");
    else this.toast("当前推荐不属于任何合集", "warn");
  }
  renderGrid() {
    const m = this.fsm.model;
    const html = m.mainQueue.items.map((it, i) => {
      const v = activeSource().getVideoMeta(it.videoId);
      const seed = m.mainQueue.seed[i];
      const poster = v?.poster || seed?.poster;
      const cls = ["g-card", i === m.mainQueue.pointer ? "cur" : ""].join(" ");
      return `<div class="${cls}" data-vid="${it.videoId}" data-idx="${i}" data-col="${seed?.collectionId || ""}" title="${(v ? v.title : it.videoId)}">
        ${poster ? `<img src="${poster}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : `<div class="g-ph"><svg class="ic" style="width:34px;height:34px"><use href="#i-film"/></svg></div>`}
        <div class="g-cat">${seed?.category || ""}</div>
        <div class="g-title">${v ? v.title : it.videoId}</div>
      </div>`;
    }).join("");
    this.els.grid.innerHTML = html;
    const grid = this.els.grid;
    grid.onclick = (ev) => {
      const card = ev.target.closest("[data-vid]");
      if (!card) return;
      const idx = parseInt(card.dataset.idx, 10);
      if (Number.isInteger(idx)) this.fsm.switchToMainIndex(idx);
      if (card.dataset.col) this.fsm.enterCollection(card.dataset.col, "playAll");
      this.toggleView();
    };
  }

  toggleHistory(on) {
    const isOn = !!on;
    this.els.hisPanel.classList.toggle("on", isOn);
    if (isOn) {
      this.renderHistory();
      this._openPanel("history", () => this.toggleHistory(false));
    } else {
      this._closePanel("history");
    }
  }
  renderHistory() {
    const list = (this.history ? this.history.list() : []).slice(0, 50);
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    this.els.hisList.innerHTML = list.length ? list.map((r) => `
      <li data-vid="${r.id || r.videoId}">
        <span class="his-cat">${r.category || "剧"}</span>
        <span class="his-t">${r.title}</span>
        <span class="his-p">${r.watched ? `<svg class="tick"><use href="#i-check"/></svg>已看完` : (r.progressSec > 3 ? `看到 ${fmt(r.progressSec)}` : "—")}</span>
        <button class="his-del no-swipe" data-del="${r.id || r.videoId}" title="删除这条记录"><svg class="ic"><use href="#i-close"/></svg></button>
      </li>`).join("")
      : `<li class="empty">暂无观看记录 —— 看过的短剧/漫剧会出现在这里</li>`;
  }
  _deleteHistory(videoId) {
    if (!this.history) return;
    this.history.remove(videoId);
    this.renderHistory();
    this.toast("已删除该条观看记录", "ok");
  }
  _clearHistory() {
    if (!this.history || !this.history.list().length) { this.toast("暂无观看记录", "warn"); return; }
    if (!confirm("确定要清除全部观看记录吗？")) return;
    this.history.clear();
    this.renderHistory();
    this.toast("已清除全部观看记录", "ok");
  }
  async _resumeHistory(videoId) {
    const rec = this.history?.get(videoId);
    if (!rec) return;
    const fromId = activeSource().id;
    this.toast(`续播：${rec.title}`, "ok");
    this.toggleHistory(false);
    const res = await this.fsm.resumeHistory(rec);
    if (res && res.ok === false) { this.toast(res.msg || "续播失败", "err"); return; }
    if (activeSource().id !== fromId) this.populateSources();
  }

  toggleSearch(on) {
    const isOn = !!on;
    this.els.searchPanel.classList.toggle("on", isOn);
    if (isOn) {
      this.els.searchSrcLabel.textContent = activeSource().label;
      this.els.searchInput.value = "";
      this.els.searchInput.focus();
      this._openPanel("search", () => this.toggleSearch(false));
    } else {
      this._closePanel("search");
    }
  }
  async _doSearch() {
    const kw = this.els.searchInput.value.trim();
    if (!kw) { this.toast("请输入搜索关键词", "warn"); return; }
    this.toast(`正在搜索：「${kw}」…`, "ok");
    const src = activeSource();
    const ok = await this.fsm.search(kw);
    this.toggleSearch(false);
    if (ok) this.toast(`搜索完成：${activeSource().label} 命中 ${this.fsm.model.mainQueue.items.length} 部，上滑浏览`, "ok");
    else this.toast(`「${kw}」无结果，或当前源（${src.label}）不支持搜索`, "err");
  }

  _renderMute(on) {
    const muted = !on || (this.player.video?.muted ?? false) ||
      ((this.player.getVolume?.() ?? 1) <= 0);
    this.els.btnMute.innerHTML = `<svg class="ic"><use href="#${muted ? "i-mute" : "i-volume"}"/></svg>`;
    this.els.btnMute.title = muted ? "开启声音" : "静音";
  }
  _renderVolume(level, muted) {
    if (this.els.volRange) {
      this.els.volRange.value = String(level);
      this._updateVolFill(level, muted);
    }
    this.els.btnMute.innerHTML =
      `<svg class="ic"><use href="#${muted || level <= 0 ? "i-mute" : "i-volume"}"/></svg>`;
    this.els.btnMute.title = (muted || level <= 0) ? "开启声音" : "静音";
  }
  _updateVolFill(level) {
    this.els.volRange.style.setProperty("--vol", String(level));
  }
  _toggleVol(open) {
    this.els.sideVol.classList.toggle("open", !!open);
  }

  _renderRate(rate) {
    const text = `${parseFloat(rate)}×`;
    this.els.btnRate.textContent = text;
    this.els.btnRate.title = `播放倍速（点按切换）：${text}`;
  }

  populateSources() {
    const cur = this.fsm._source?.id;
    this.els.srcSel.innerHTML = listSources()
      .map((s) => `<option value="${s.id}" ${s.id === cur ? "selected" : ""}>${s.label}</option>`)
      .join("");
    this._loadBaseInput(cur);
  }
  _loadBaseInput(id) {
    const val = getBaseUrl(id);
    this.els.srcBaseInput.value = val || "";
    this.els.srcBaseInput.placeholder = val
      ? `自定义地址：${val}（清空并保存即还原）`
      : "自定义源地址（留空 = 同源代理）";
    if (this.els.srcProxy) this.els.srcProxy.checked = getProxy(id);
  }
  _saveSrcBase() {
    const id = this.els.srcSel.value;
    const val = setSourceBase(id, this.els.srcBaseInput.value, this.els.srcProxy.checked);
    this._loadBaseInput(id);
    this.toast(
      this.els.srcProxy.checked
        ? `已启用代理：走同源`
        : (val ? `已保存自定义地址：${val}` : "已清除自定义地址（走默认代理）"),
      "ok",
    );
    // 自定义源地址 / 代理变更后重新拉取主队列，使新 baseURL 生效
    this.fsm.switchSource(id).then((r) => {
      const rg = r && typeof r === "object" ? r : { ok: !!r };
      if (rg.ok && !rg.failed) this.toast("已重新拉取主队列", "ok");
      else if (!rg.stale) this.toast("主队列重新拉取失败", "err");
    });
  }

  _bindMedia() {
    const v = this.els.video;
    const sync = () => { this._syncLoader(); this.renderPlayBtn(); };
    ["loadstart", "waiting", "emptied"].forEach((ev) => v.addEventListener(ev, () => { this._stalled = true; }));
    ["playing", "canplay", "loadeddata"].forEach((ev) => v.addEventListener(ev, () => { this._stalled = false; }));
    ["loadstart", "waiting", "playing", "canplay", "loadeddata", "pause", "play", "error", "emptied"]
      .forEach((ev) => v.addEventListener(ev, sync));
    v.addEventListener("timeupdate", () => {
      const d = v.duration || 0, c = v.currentTime || 0;
      this.els.barFill.style.width = d ? `${Math.min(100, (c / d) * 100)}%` : "0%";
      this._stalled = false;
      this._syncLoader();
    });
  }

  _syncLoader() {
    const v = this.els.video;
    this.els.loader.classList.toggle("on", !v.currentSrc || (!!this._stalled && !v.paused));
  }

  renderPlayBtn() {
    const v = this.els.video;
    this.els.btnPlay.innerHTML = `<svg class="ic"><use href="#${v.paused ? "i-play" : "i-pause"}"/></svg>`;
    this.els.bigPlay.classList.toggle("on", v.paused);
  }

  _bindGestures() {
    const stage = this.els.stage;
    const deck = this.els.deck;
    let sx = 0, sy = 0, st = 0, dragging = false, axis = null;

    const isNoSwipe = (t) => !!(t && t.closest && t.closest(".no-swipe"));

    const onDown = (ev) => {
      if (isNoSwipe(ev.target)) return;
      dragging = true; axis = null;
      sx = ev.clientX; sy = ev.clientY; st = performance.now();
      deck.style.transition = "none";
    };
    const onMove = (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!axis) {
        if (Math.abs(dx) < GESTURE.axisDead && Math.abs(dy) < GESTURE.axisDead) return;
        axis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
      }
      if (axis !== "y") return;
      ev.preventDefault();
      deck.style.transform = `translateY(${this._damp(dy)}px)`;
    };
    const onUp = (ev) => {
      if (!dragging) return;
      dragging = false;
      const dt = performance.now() - st;
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (axis === "y") {
        const far = Math.abs(dy) >= GESTURE.minDistance;
        const flick = Math.abs(dy) >= GESTURE.flickDistance && dt <= GESTURE.flickMs;
        if (far || flick) { this.swipe(dy < 0 ? -1 : 1); return; }
        this._snapBack(); return;
      }
      const isTap = Math.abs(dx) <= GESTURE.tapMaxMove
        && Math.abs(dy) <= GESTURE.tapMaxMove && dt <= GESTURE.tapMaxMs;
      const inClean = this.els.stage.classList.contains("clean");
      if (inClean && isTap && !isNoSwipe(ev.target)) {
        this.els.stage.classList.toggle("ui-revealed");
      } else if (!inClean && !isNoSwipe(ev.target) && isTap) {
        this.player.togglePlay();
        this.renderPlayBtn();
      }
      this._snapBack();
    };

    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("pointermove", onMove, { passive: false });
    stage.addEventListener("pointerup", onUp);
    stage.addEventListener("pointercancel", () => { dragging = false; this._snapBack(); });

    stage.addEventListener("wheel", (ev) => {
      if (isNoSwipe(ev.target)) return;
      const now = performance.now();
      if (now < this._wheelLockUntil) return;
      if (Math.abs(ev.deltaY) < GESTURE.wheelThreshold) return;
      ev.preventDefault();
      this._wheelLockUntil = now + GESTURE.wheelLockMs;
      this.swipe(ev.deltaY > 0 ? -1 : 1);
    }, { passive: false });

    document.addEventListener("keydown", (ev) => {
      const tag = ev.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (ev.key === "j" || ev.key === "J") { this.toggleClean(); return; } // 清屏 / 退出清屏
      if (ev.key === "f" || ev.key === "F") { this._enterCollectionByKey(); return; } // 进入合集
      if (ev.key === "h" || ev.key === "H") { this.toggleHelp(); return; } // 快捷键帮助
      if (ev.key === "ArrowDown") { ev.preventDefault(); this.swipe(-1); return; }
      if (ev.key === "ArrowUp") { ev.preventDefault(); this.swipe(1); return; }
      if (ev.key === " ") { ev.preventDefault(); this.player.togglePlay(); this.renderPlayBtn(); return; }
      // 左右方向键：区分点击（短按）与长按
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
        ev.preventDefault();
        this._onLRKeydown(ev, ev.key === "ArrowRight" ? 1 : -1);
      }
    });
    document.addEventListener("keyup", (ev) => {
      if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") this._onLRKeyup(ev);
    });
  }

  /** 左右方向键按下。首键按下计时，长按超过阈值时（由自动重复 keydown 触发）执行长按动作一次。 */
  _onLRKeydown(ev, dir) {
    if (!ev.repeat) { // 仅首按开始计时
      this._lrHold = { key: ev.key, dir, start: performance.now(), longFired: false };
      return;
    }
    const h = this._lrHold;
    if (h && h.key === ev.key && !h.longFired && performance.now() - h.start >= GESTURE.longPressMs) {
      h.longFired = true;
      h.prevRate = this.player.getPlaybackRate(); // 长按前的倍速，松开后恢复
      this._applyLRLong(h.dir);
    }
  }

  /** 左右方向键抬起。未长按则按点击处理；已长按则恢复长按前的倍速。 */
  _onLRKeyup(ev) {
    const h = this._lrHold;
    this._lrHold = null;
    if (!h || h.key !== ev.key) return;
    if (h.longFired) {
      this.player.setPlaybackRate(h.prevRate);
      this._renderRate(h.prevRate);
      this.toast(`长按结束 · 恢复倍速 ${parseFloat(h.prevRate)}×`, "ok");
      return;
    }
    this._applyLRTap(h.dir);
  }

  /** 点击（短按）：右=前进10s，左=后退10s */
  _applyLRTap(dir) {
    this.player.seekRelative(dir * 10);
    this.toast(dir > 0 ? "前进 10s" : "后退 10s", "ok");
  }

  /** 长按：右=2x，左=0.5x */
  _applyLRLong(dir) {
    const rate = dir > 0 ? 2 : 0.5;
    this.player.setPlaybackRate(rate);
    this._renderRate(rate);
    this.toast(`长按 · 倍速 ${parseFloat(rate)}×`, "ok");
  }

  _damp(dy) {
    const can = dy < 0 ? this.fsm.canSwipeNext() : this.fsm.canSwipePrev();
    return can ? dy * 0.86 : dy * 0.3;
  }

  swipe(dir) {
    if (this._busy) this._finishAnim();
    const ok = dir < 0 ? this.fsm.swipeNext() : this.fsm.swipePrev();
    if (ok) {
      this._animate(dir);
      this._hint(dir < 0 ? "↑ 下一个" : "↓ 上一个");
    } else {
      this._snapBack();
      this.toast(dir < 0 ? "没有更多了" : this._topReason(), "warn");
    }
  }

  _topReason() {
    const cq = this.fsm.model.collectionQueue;
    switch (this.fsm.state) {
      case STATE.MAIN_QUEUE:
        if (cq?.exited) return "已退出合集尾巴单向，不支持回看";
        return "已经是第一个推荐";
      case STATE.COLLECTION_QUEUE:
        return "已经是第一集";
      default:
        return "当前状态不支持上翻";
    }
  }

  _animate(dir) {
    const deck = this.els.deck;
    this._clearAnim();
    this._busy = true;
    deck.style.transition = "transform .24s cubic-bezier(.22,.61,.36,1), opacity .24s ease";
    deck.style.transform = `translateY(${dir * 100}%)`;
    deck.style.opacity = "0";
    this._t1 = setTimeout(() => {
      deck.style.transition = "none";
      deck.style.transform = `translateY(${-dir * 34}%)`;
      requestAnimationFrame(() => {
        deck.style.transition = "transform .3s cubic-bezier(.22,.61,.36,1), opacity .3s ease";
        deck.style.transform = "translateY(0)";
        deck.style.opacity = "1";
        this._t2 = setTimeout(() => this._finishAnim(), 320);
      });
    }, 250);
  }

  _clearAnim() {
    if (this._t1) { clearTimeout(this._t1); this._t1 = null; }
    if (this._t2) { clearTimeout(this._t2); this._t2 = null; }
  }

  _finishAnim() {
    this._clearAnim();
    const deck = this.els.deck;
    deck.style.transition = "";
    deck.style.transform = "translateY(0)";
    deck.style.opacity = "1";
    this._busy = false;
  }

  _snapBack() {
    const deck = this.els.deck;
    this._clearAnim();
    this._busy = false;
    deck.style.transition = "transform .22s cubic-bezier(.22,.61,.36,1)";
    deck.style.transform = "translateY(0)";
    deck.style.opacity = "1";
    setTimeout(() => { deck.style.transition = ""; }, 240);
  }

  _hint(text) {
    const el = this.els.hintSwipe;
    el.textContent = text;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
  }

  renderAll() {
    this.renderState(); this.renderMeta(); this.renderRail();
    this.renderControls(); this.renderPanel(); this._syncLoader();
    if (this.els.epPanel.classList.contains("on")) this.renderEpisodes();
  }

  toggleEpisodes(on) {
    const isOn = !!on;
    this.els.epPanel.classList.toggle("on", isOn);
    this.els.epMask.classList.toggle("on", isOn);
    if (isOn) {
      this.renderEpisodes();
      this._openPanel("episodes", () => this.toggleEpisodes(false));
    } else {
      this._closePanel("episodes");
    }
  }

  renderEpisodes() {
    const m = this.fsm.model;
    const cq = m.collectionQueue;
    if (!cq) return;
    const src = activeSource();
    const def = src.getCollectionMeta(cq.collectionId);
    const exitedLabel = cq.exited ? " · 已退出" : "";
    this.els.epTitle.textContent = `选集 · ${def?.title || cq.collectionId}${exitedLabel}（${cq.items.length} 集）`;
    const curVid = m.currentVideoId();
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    this.els.epList.innerHTML = cq.items.map((it, i) => {
      const v = src.getVideoMeta(it.videoId);
      const prog = it.progressSec || 0;
      const watched = it.state === "played";
      const note = watched
        ? `<svg class="tick"><use href="#i-check"/></svg>已看完`
        : (prog > 3 ? `看到 ${fmt(prog)}` : "");
      const cls = ["ep-item", it.videoId === curVid ? "cur" : "", watched ? "watched" : ""].join(" ");
      return `<li class="${cls}" data-idx="${i}">
        <span class="ep-no">EP${i + 1}</span>
        <span class="ep-t">${v ? v.title : it.videoId}</span>
        <span class="ep-p">${note}</span></li>`;
    }).join("");
  }

  renderState() {
    const s = this.fsm.state;
    const cq = this.fsm.model.collectionQueue;
    let label = STATE_LABEL[s] || s;
    if (s === STATE.MAIN_QUEUE && cq?.exited) label = "退出续播";
    this.els.state.textContent = label;
    this.els.state.className = "badge s-" + s + (cq?.exited ? " exited" : "");
  }

  _metaFromHistory(vid) {
    const rec = this.history ? this.history.get(vid) : null;
    if (!rec) return null;
    const s = rec.sourceId ? registry.get(rec.sourceId) : null;
    const m = s?.getVideoMeta?.(vid);
    if (m) return m;
    if (rec.title || rec.poster) return { title: rec.title || null, poster: rec.poster, category: rec.category };
    return null;
  }

  renderMeta() {
    const m = this.fsm.model;
    const src = activeSource();
    const vid = m.currentVideoId();
    const v = src.getVideoMeta(vid) || this._metaFromHistory(vid);
    const st = this.fsm.state;
    const cq = m.collectionQueue;

    let cat = "短剧";
    if (st === STATE.MAIN_QUEUE || st === STATE.FALLBACK) {
      if (cq?.exited) {
        cat = src.getCollectionMeta(cq.collectionId)?.category || "短剧";
      } else {
        cat = m.mainQueue.seed[m.mainQueue.pointer]?.category || "短剧";
      }
    } else if (st === STATE.LOAD_COLLECTION) {
      const at = m.enteredMainIndex >= 0 ? m.enteredMainIndex : m.mainQueue.pointer;
      cat = m.mainQueue.seed[at]?.category || "短剧";
    } else if (st === STATE.COLLECTION_QUEUE) {
      cat = src.getCollectionMeta(m.collectionQueue.collectionId)?.category || "短剧";
    }
    this.els.cat.textContent = cat;
    // 标题：主队列/降级态下若当前元素是集外分集（退出合集后仍站主队列），显示「剧名 + 第N集」；
    // 合集队列内仍用元素自身标题（第N集），仅缺集号时按队列指针补上。
    let title = v?.title || vid || "—";
    if (st === STATE.MAIN_QUEUE || st === STATE.FALLBACK) {
      const full = episodeDisplayTitle(src, v);
      if (full) title = full;
    } else if (st === STATE.COLLECTION_QUEUE && cq) {
      const epLabel = `第${cq.pointer + 1}集`;
      if (!/(?:第\s*\d+\s*集)/.test(title)) title = `${title} · ${epLabel}`;
    }
    this.els.title.textContent = title;

    const mq = m.mainQueue;
    if (st === STATE.COLLECTION_QUEUE) {
      const cqd = m.collectionQueue;
      const def = src.getCollectionMeta(cqd.collectionId);
      this.els.sub.textContent = `${def?.title || cqd.collectionId} · EP ${cqd.pointer + 1}/${cqd.items.length}`;
    } else if (cq?.exited) {
      const def = src.getCollectionMeta(cq.collectionId);
      const tail = m.exitedTailLength();
      this.els.sub.textContent = `${def?.title || cq.collectionId} · 退出续播 · 尾巴 ${tail} 集${cq.tailLazy ? "（懒恢复）" : ""}`;
    } else if (st === STATE.LOAD_COLLECTION) {
      this.els.sub.textContent = "正在加载分集…";
    } else if (st === STATE.FALLBACK) {
      this.els.sub.textContent = "加载失败，已回推荐流";
    } else {
      this.els.sub.textContent = `第 ${mq.pointer + 1}/${mq.items.length} 个推荐 · 源 ${src.label || src.id}`;
    }

    const tip = {
      [STATE.MAIN_QUEUE]: cq?.exited
        ? "上滑 → 尾巴续播（不支持上翻）"
        : "上滑 → 下一个推荐 下滑 → 上一个推荐",
      [STATE.COLLECTION_QUEUE]: "上滑 → 下一集 下滑 → 上一集",
      [STATE.LOAD_COLLECTION]: "加载中…",
      [STATE.FALLBACK]: "已降级，上滑继续浏览推荐",
    }[st] || "";
    this.els.tip.textContent = tip;
  }

  renderRail() {
    const m = this.fsm.model;
    const st = this.fsm.state;
    const cq = m.collectionQueue;
    let total = 0, cur = -1;

    if (st === STATE.COLLECTION_QUEUE) {
      total = m.collectionQueue.items.length;
      cur = m.collectionQueue.pointer;
    } else if (cq?.exited) {
      // 已退出合集：显示合集刻度
      total = cq.items.length;
      cur = cq.pointer;
    } else if (st === STATE.LOAD_COLLECTION) {
      total = m.mainQueue.items.length;
      cur = m.enteredMainIndex >= 0 ? m.enteredMainIndex : m.mainQueue.pointer;
    } else {
      total = m.mainQueue.items.length;
      cur = m.mainQueue.pointer;
    }
    if (!total) { this.els.rail.innerHTML = ""; return; }

    const win = GESTURE.railWindow;
    const start = Math.max(0, Math.min(cur - Math.floor(win / 2), Math.max(0, total - win)));
    const end = Math.min(total, start + win);
    let html = "";
    for (let i = start; i < end; i++) {
      const cls = i === cur ? "cur" : (i < cur ? "done" : "");
      html += `<i class="${cls}"></i>`;
    }
    this.els.rail.innerHTML = html;
  }

  renderControls() {
    const m = this.fsm.model;
    const st = this.fsm.state;
    const seed = m.mainQueue.seed[m.mainQueue.pointer];
    const cq = m.collectionQueue;
    const exited = cq?.exited;
    this.els.btnColl.disabled = !(st === STATE.MAIN_QUEUE && (seed?.collectionId || exited));
    this.els.btnColl.title = exited
      ? `重入合集 ${cq?.collectionId || ""}`
      : (seed?.collectionId ? `连播合集 ${seed.collectionId}` : "当前推荐不属于任何合集");
    this.els.btnExit.disabled = st !== STATE.COLLECTION_QUEUE;
    this.els.btnExit.innerHTML = `<svg class="ic"><use href="#i-exit"/></svg>`;
    this.els.btnExit.title = "退出合集（当前集不中断）";
    this.els.btnEps.disabled = !this.fsm.canJumpEpisode();
    this.els.btnEps.title = this.fsm.canJumpEpisode() ? "手动选集" : "仅合集内可手动选集";
  }

  renderMetrics(m) {
    const pct = (x) => (x * 100).toFixed(0) + "%";
    this.els.pMetrics.textContent =
      `完播 ${pct(m.collectionFinishRate)} · 保持 ${pct(m.stitchKeepRate)} · 降级 ${pct(m.fallbackRate)} · 尾巴深度 ${m.tailDepth.toFixed(2)}`;
  }

  renderPanel() {
    const m = this.fsm.model;
    const st = this.fsm.state;
    const cq = m.collectionQueue;
    const src = activeSource();
    const vid = m.mainCurrentVideoId();
    const v = src?.getVideoMeta?.(vid) || this._metaFromHistory(vid);
    const full = episodeDisplayTitle(src, v);
    this.els.pState.textContent = `${st}${cq?.exited ? " (exited)" : ""}`;
    this.els.pMain.textContent = `#${m.mainQueue.pointer + 1}/${m.mainQueue.items.length} · ${full || v?.title || vid || "—"}`;
    this.els.pColl.textContent = cq
      ? `${src?.getCollectionMeta?.(cq.collectionId)?.title || cq.items[cq.pointer]?.title || cq.collectionId} EP${cq.pointer + 1}/${cq.items.length}${cq.exited ? ` (已退出 · 尾巴 ${m.exitedTailLength()} · 槽位 #${cq.replacedIndex + 1}${cq.tailLazy ? " · 懒恢复" : ""})` : ""}`
      : "—";
    const c = this.preload.current;
    this.els.pPre.textContent = c ? `${c.videoId} · ${c.level} · ${c.state}` : "无目标";
  }

  _bindConfig() {
    const KB = 1024;
    const fields = [
      ["cfgPreloadEnabled",      "enabled",            (v) => !!v],
      ["cfgTriggerRemainingSec", "triggerRemainingSec",(v) => Number(v)],
      ["cfgTriggerRatio",        "triggerRatio",       (v) => Number(v)],
      ["cfgMinSinceStartSec",    "minSinceStartSec",   (v) => Number(v)],
      ["cfgPreloadBytesL2",      "preloadBytesL2",     (v) => Math.round(v / KB)],
      ["cfgPreloadBytesL3",      "preloadBytesL3",     (v) => Math.round(v / KB)],
    ];
    this._cfgDefaults = {};
    this._cfg = {};
    for (const [id, key, toDisplay] of fields) {
      const el = this.els[id];
      this._cfg[key] = el;
      this._cfgDefaults[key] = CONFIG.preload[key];
      el.addEventListener("change", () => {
        CONFIG.preload[key] = el.type === "checkbox" ? el.checked : Number(el.value);
      });
      this._setCfgField(key, CONFIG.preload[key], toDisplay);
    }
    this.els.cfgReset.onclick = () => {
      for (const [key, toDisplay] of fields.map(([, k, d]) => [k, d])) {
        CONFIG.preload[key] = this._cfgDefaults[key];
        this._setCfgField(key, this._cfgDefaults[key], toDisplay);
      }
      this.toast("已恢复预加载默认配置", "ok");
    };

    // —— 调试工具（即时生效）——
    const dbgLabels = { wifi: "Wi-Fi", cellular: "蜂窝", saveData: "省流" };
    this.els.dbgNetwork.addEventListener("change", () => {
      this.fsm.networkLevel = this.els.dbgNetwork.value;
      this.preload._recompute();
      this.toast(`网络类型：${dbgLabels[this.fsm.networkLevel] || this.fsm.networkLevel}（预加载等级封顶更新）`, "ok");
      this.renderPanel();
    });
    this.els.btnDbgPreload.onclick = () => {
      if (!CONFIG.preload.enabled) { this.toast("请先启用预加载", "warn"); return; }
      const ok = this.preload.forceNow();
      this.toast(ok ? "已触发立即预取" : (this.preload.current?.state === "done" ? "当前目标已在缓存" : "当前无预加载目标"), ok ? "ok" : "warn");
    };
    this.els.btnDbgRefresh.onclick = () => {
      this.fsm.requestRefresh("manual", { force: true });
      this.toast("已强制刷新主队列", "ok");
    };
    this.els.btnDbgClearLocal.onclick = () => {
      if (!confirm("确定清除观看记录与缝合快照？（视频源偏好保留）")) return;
      this.history?.clear();
      try { localStorage.removeItem(CONFIG.snapshot.storageKey); } catch { /* 忽略 */ }
      this.toast("已清除观看记录与快照", "ok");
      this.renderHistory();
    };
  }
  _setCfgField(key, value, toDisplay) {
    const el = this._cfg[key];
    if (!el) return;
    if (el.type === "checkbox") el.checked = !!value;
    else el.value = toDisplay ? toDisplay(value) : value;
  }

  log(type, payload, kind = "") {
    const div = document.createElement("div");
    if (kind) div.className = kind;
    div.innerHTML = `<b>${type}</b> ${this._sum(payload)}`;
    this.els.pLog.prepend(div);
    while (this.els.pLog.children.length > 40) this.els.pLog.lastChild.remove();
  }
  _sum(p) {
    try { return Object.entries(p).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" "); }
    catch { return ""; }
  }

  toast(msg, kind = "") {
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.textContent = msg;
    this.els.toast.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }
}
