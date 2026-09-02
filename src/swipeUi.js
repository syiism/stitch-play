// swipeUi.js · 竖屏滑动 UI（只读总线 + 手势输入）
//
// 与控制台 UI（ui.js）共享同一套内核：状态机 + 事件总线 + 预加载 + 埋点 + 快照，
// 只是换了「输入方式」与「呈现形态」：
//   输入：上滑/下滑（指针拖拽、滚轮、方向键）→ fsm.swipeNext()/swipePrev()
//   呈现：抖音式全屏卡片 + HUD（状态徽标 / 分类 / 标题 / 集数 / 进度条）
//
// 语义映射（由内核裁决，UI 不自己改队列）：
//   推荐流   上滑=下一个推荐（消费，到底续拉）        下滑=上一个推荐（不消费）
//   合集     上滑=下一集；末集上滑=播完自动回推荐流    下滑=上一集（不消费）
//   缝合态   上滑=沿尾巴续播下一集；尾巴尽则脱离       下滑=尾巴单向，不支持回看

import { EVENT } from "./eventBus.js";
import { STATE } from "./queueModel.js";
import { CONFIG } from "./config.js";
import { activeSource, listSources } from "./sources/index.js";

const STATE_LABEL = {
  [STATE.MAIN_QUEUE]: "推荐流",
  [STATE.LOAD_COLLECTION]: "加载合集…",
  [STATE.COLLECTION_QUEUE]: "合集连播",
  [STATE.STITCH]: "缝合续播",
  [STATE.FALLBACK]: "降级回推荐",
};

// 手势阈值（集中配置，便于调优）
const GESTURE = {
  minDistance: 60,      // 触发滑动的主轴位移（px）
  flickDistance: 28,    // 快速轻扫的位移下限（配合 flickMs）
  flickMs: 260,         // 轻扫判定的时间上限
  axisDead: 6,          // 轴向判定前的死区
  tapMaxMs: 400,        // 点击（播放/暂停）最长时间
  tapMaxMove: 10,       // 点击最大位移
  wheelLockMs: 450,     // 滚轮节流锁
  wheelThreshold: 30,   // 滚轮触发阈值
  railWindow: 14,       // 左侧刻度最多显示的条目数（窗口化）
};

export class SwipeUI {
  constructor({ fsm, player, tracker, preload, snapshot, history, els }) {
    this.fsm = fsm; this.player = player; this.tracker = tracker;
    this.preload = preload; this.snapshot = snapshot; this.history = history || null; this.els = els;
    this._busy = false;          // 动画进行中，吞掉后续手势
    this._wheelLockUntil = 0;

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

  // ============ 订阅输出事件（只读） ============
  _subscribe() {
    const b = this.fsm.bus;
    const R = () => this.renderAll();
    b.on(EVENT.STATE_CHANGED, (p) => { R(); this.log("StateChanged", p); });
    b.on(EVENT.ITEM_CONSUMED, (p) => { this.renderRail(); this.log("ItemConsumed", p); });
    b.on(EVENT.COLLECTION_ENTERED, (p) => { R(); this.log("CollectionEntered", p); });
    b.on(EVENT.COLLECTION_EXITED, (p) => {
      R(); this.log("CollectionExited", p, p.exitType === "autoFinish" ? "ok" : "stitch");
      if (p.exitType === "autoFinish") this.toast("本剧已看完，回到推荐流", "ok");
    });
    b.on(EVENT.STITCH_ENTERED, (p) => { R(); this.log("StitchEntered", p, "stitch"); this.toast(`进入缝合续播，尾巴 ${p.tailLength} 集`, "stitch"); });
    b.on(EVENT.STITCH_TAIL_ADVANCED, (p) => { R(); if (!p.ignored) this.log("StitchTailAdvanced", p); });
    b.on(EVENT.STITCH_EXITED, (p) => { R(); this.log("StitchExited", p, "ok"); });
    b.on(EVENT.MAIN_QUEUE_REPLACED, (p) => { R(); this.log("MainQueueReplaced", p); });
    b.on(EVENT.MAIN_QUEUE_REFRESHED, (p) => { R(); this.log("MainQueueRefreshed", p, p.dropped ? "err" : "ok"); });
    b.on(EVENT.FALLBACK_TRIGGERED, (p) => { R(); this.log("FallbackTriggered", p, "err"); this.toast(`降级：${p.scene}/${p.reason}`, "err"); });
    b.on(EVENT.PRELOAD_STAGE, (p) => this.renderPanel());
    // 视频源切换完成 → 全量渲染（UI 标签 / 队列指针 / 状态徽标等跟随新源）
    b.on(EVENT.PROVIDER_READY, (p) => { R(); this.log("ProviderReady", p, p.switched ? "ok" : ""); });
    this.tracker.onFlush = (batch, metrics) => this.renderMetrics(metrics);
  }

  // ============ 控件 ============
  _bindControls() {
    const e = this.els;
    // 「更多」浮层（移动端收起顶部次控按钮；点击 ⋯ 开关 / 点空白收起 / 按 ESC 收起）
    e.btnMore.onclick = () => this._toggleMore();
    document.addEventListener("pointerdown", (ev) => {
      if (this.els.topMore.classList.contains("on") &&
          !ev.target.closest("#topMore") && !ev.target.closest("#btnMore")) this._toggleMore(false);
    });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") this._toggleMore(false); });
    e.btnPlay.onclick = () => { this.player.togglePlay(); this.renderPlayBtn(); };
    this._renderMute(false);
    this.player.onMuteChange = (muted) => this._renderMute(!muted);
    e.btnMute.onclick = () => {
      const on = this.player.toggleMute();
      this._renderMute(on);
      this.toast(on ? "声音已开启" : "已静音", "ok");
    };
    // 进入合集（仅推荐流且当前卡片属于某合集）
    e.btnColl.onclick = () => {
      const seed = this.fsm.model.mainQueue.seed[this.fsm.model.mainQueue.pointer];
      if (seed?.collectionId) this.fsm.enterCollection(seed.collectionId, "playAll");
    };
    // 手动选集：底部抽屉列出合集全部剧集，点选跳转（内核裁决，合集态/缝合态可用）
    e.btnEps.onclick = () => this.toggleEpisodes(true);
    e.btnEpsClose.onclick = () => this.toggleEpisodes(false);
    e.epMask.onclick = () => this.toggleEpisodes(false);
    e.epList.onclick = (ev) => {
      const li = ev.target.closest("[data-idx]");
      if (!li) return;
      const idx = parseInt(li.dataset.idx, 10);
      // 记录跳转前的当前集 → 决定卡片动画方向（往后跳=上滑视觉，往前跳=下滑视觉）
      const m = this.fsm.model;
      const prevIdx = m.stitch.active
        ? (m.collectionQueue?.items.findIndex((i) => i.videoId === m.stitch.currentVideoId) ?? -1)
        : (m.collectionQueue ? m.collectionQueue.pointer : -1);
      if (!this.fsm.jumpToEpisode(idx)) { this.toast("当前状态不可跳转", "warn"); return; }
      this.toggleEpisodes(false);
      this.renderAll();
      this._animate(idx > prevIdx ? -1 : 1);
      this.toast(`已跳到第 ${idx + 1} 集`, "ok");
    };
    // 退出：合集态 → 缝合续播；缝合态 → 脱离回推荐流下一项
    e.btnExit.onclick = () => {
      if (this.fsm.state === STATE.COLLECTION_QUEUE) { this.fsm.exitCollection(); this.toast("已退出到缝合续播", "stitch"); }
      else if (this.fsm.state === STATE.STITCH) { this.fsm.switchToNextMain(); this.toast("已脱离合集，回到推荐流", "ok"); }
    };
    e.btnPanel.onclick = () => e.panel.classList.toggle("on");
    e.btnPanelClose.onclick = () => e.panel.classList.remove("on");
    // 搜索：顶部浮层输入关键词 → fsm.search 替换主队列（结果作为推荐流）
    e.btnSearch.onclick = () => this.toggleSearch(true);
    e.btnSearchClose.onclick = () => this.toggleSearch(false);
    e.btnSearchGo.onclick = () => this._doSearch();
    e.searchInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") this._doSearch(); });
    e.srcSel.onchange = () => {
      const id = e.srcSel.value;
      this.toast("切换源中…", "warn");
      this.fsm.switchSource(id).then((ok) => {
        if (ok) this.toast(`已切换：${activeSource().label}`, "ok");
        else {
          this.populateSources(); // 失败已回滚到原源：下拉框同步回实际激活源
          this.toast(`切换失败：${id} 加载失败，已保持原源`, "err");
        }
      });
    };
    // —— 全屏（F11 语义） ——
    e.btnFs.onclick = () => this.toggleFullscreen();
    document.addEventListener("fullscreenchange", () => this._syncFsIcon());
    // —— 宫格浏览 / 滑动播放 切换（PC 友好） ——
    e.btnView.onclick = () => this.toggleView();
    // —— 观看记录抽屉 ——
    e.btnHistory.onclick = () => this.toggleHistory(true);
    e.btnHisClose.onclick = () => this.toggleHistory(false);
    e.btnHisClear.onclick = () => this._clearHistory();
    e.hisList.onclick = (ev) => {
      // 条目右侧的删除按钮（圆圈叉）：只删记录，不触发续播
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
      try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch { /* 不支持的浏览器忽略 */ }
    };
    if (document.fullscreenElement) { unlock(); document.exitFullscreen(); }
    else if (el.requestFullscreen) { unlock(); el.requestFullscreen(); }
  }

  /** 进入/退出全屏后刷新全屏按钮图标 */
  _syncFsIcon() {
    const on = !!document.fullscreenElement;
    this.els.btnFs.innerHTML = `<svg class="ic"><use href="#${on ? "i-fs-exit" : "i-fs-enter"}"/></svg>`;
    this.els.btnFs.title = on ? "退出全屏" : "全屏";
  }

  // ============ 「更多」浮层开关（移动端收起顶部次控按钮） ============
  _toggleMore(force) {
    const on = force !== undefined ? !!force : !this.els.topMore.classList.contains("on");
    this.els.topMore.classList.toggle("on", on);
  }

  // ============ 宫格浏览（PC 桌面友好视图） ============
  toggleView() {
    const on = !this.els.view.classList.contains("on");
    this.els.view.classList.toggle("on", on);
    this.els.btnView.innerHTML = on
      ? `<svg class="ic"><use href="#i-play"/></svg><span>滑动</span>`
      : `<svg class="ic"><use href="#i-grid"/></svg><span>宫格</span>`;
    this.els.btnView.title = on ? "回到滑动播放" : "宫格浏览";
    if (on) this.renderGrid();
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
    // 网格点击 → 点谁指针指谁（switchToMainIndex）：带合集 → 进其合集（替换槽位=该项）；
    // 否则点击播放该推荐
    const grid = this.els.grid;
    grid.onclick = (ev) => {
      const card = ev.target.closest("[data-vid]");
      if (!card) return;
      const idx = parseInt(card.dataset.idx, 10);
      if (Number.isInteger(idx)) this.fsm.switchToMainIndex(idx); // 点谁指针指谁
      if (card.dataset.col) this.fsm.enterCollection(card.dataset.col, "playAll");
      this.toggleView();
    };
  }

  // ============ 观看记录（本地 localStorage 续播） ============
  toggleHistory(on) {
    this.els.hisPanel.classList.toggle("on", on);
    if (on) this.renderHistory();
  }
  renderHistory() {
    const list = (this.history ? this.history.list() : []).slice(0, 50);
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    this.els.hisList.innerHTML = list.length ? list.map((r) => `
      <li data-vid="${r.videoId}">
        <span class="his-cat">${r.category || "剧"}</span>
        <span class="his-t">${r.title}</span>
        <span class="his-p">${r.watched ? `<svg class="tick"><use href="#i-check"/></svg>已看完` : (r.progressSec > 3 ? `看到 ${fmt(r.progressSec)}` : "—")}</span>
        <button class="his-del no-swipe" data-del="${r.videoId}" title="删除这条记录"><svg class="ic"><use href="#i-close"/></svg></button>
      </li>`).join("")
      : `<li class="empty">暂无观看记录 —— 看过的短剧/漫剧会出现在这里</li>`;
  }

  /** 删除单条观看记录（圆圈叉） */
  _deleteHistory(videoId) {
    if (!this.history) return;
    this.history.remove(videoId);
    this.renderHistory();
    this.toast("已删除该条观看记录", "ok");
  }

  /** 清除全部观看记录 */
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
    this.toast(`续播：${rec.title}`, "ok");
    this.toggleHistory(false);
    const res = await this.fsm.resumeHistory(rec);
    if (res && res.ok === false) this.toast(res.msg || "续播失败", "err");
  }

  toggleSearch(on) {
    this.els.searchPanel.classList.toggle("on", on);
    if (on) {
      this.els.searchSrcLabel.textContent = activeSource().label;
      this.els.searchInput.value = "";
      this.els.searchInput.focus();
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
    this.els.btnMute.innerHTML = `<svg class="ic"><use href="#${on ? "i-volume" : "i-mute"}"/></svg>`;
    this.els.btnMute.title = on ? "静音" : "开启声音";
  }

  populateSources() {
    const cur = this.fsm._source?.id;
    this.els.srcSel.innerHTML = listSources()
      .map((s) => `<option value="${s.id}" ${s.id === cur ? "selected" : ""}>${s.label}</option>`)
      .join("");
  }

  // ============ 媒体状态（loader / 大播放键 / 进度条） ============
  _bindMedia() {
    const v = this.els.video;
    const sync = () => { this._syncLoader(); this.renderPlayBtn(); };
    // 缓冲遮罩交给浏览器的 waiting/playing 语义判定：网络吃紧时 readyState 会长期停在 2
    // （HAVE_CURRENT_DATA）而画面仍在推进，按 readyState 阈值判断会让「加载中」常亮。
    ["loadstart", "waiting", "emptied"].forEach((ev) => v.addEventListener(ev, () => { this._stalled = true; }));
    ["playing", "canplay", "loadeddata"].forEach((ev) => v.addEventListener(ev, () => { this._stalled = false; }));
    ["loadstart", "waiting", "playing", "canplay", "loadeddata", "pause", "play", "error", "emptied"]
      .forEach((ev) => v.addEventListener(ev, sync));
    v.addEventListener("timeupdate", () => {
      const d = v.duration || 0, c = v.currentTime || 0;
      this.els.barFill.style.width = d ? `${Math.min(100, (c / d) * 100)}%` : "0%";
      this._stalled = false; // 时间在推进就没卡住
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

  // ============ 手势：上滑 / 下滑 ============
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
      // 未成轴向 = 点击 → 播放/暂停
      if (!isNoSwipe(ev.target) && Math.abs(dx) <= GESTURE.tapMaxMove
          && Math.abs(dy) <= GESTURE.tapMaxMove && dt <= GESTURE.tapMaxMs) {
        this.player.togglePlay();
        this.renderPlayBtn();
      }
      this._snapBack();
    };

    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("pointermove", onMove, { passive: false });
    stage.addEventListener("pointerup", onUp);
    stage.addEventListener("pointercancel", () => { dragging = false; this._snapBack(); });

    // 滚轮（桌面）：向下滚 = 下一个
    stage.addEventListener("wheel", (ev) => {
      if (isNoSwipe(ev.target)) return;
      const now = performance.now();
      if (now < this._wheelLockUntil) return;
      if (Math.abs(ev.deltaY) < GESTURE.wheelThreshold) return;
      ev.preventDefault();
      this._wheelLockUntil = now + GESTURE.wheelLockMs;
      this.swipe(ev.deltaY > 0 ? -1 : 1);
    }, { passive: false });

    // 键盘：↓ 下一个 / ↑ 上一个 / 空格 播放暂停（输入框聚焦时忽略，避免误触）
    document.addEventListener("keydown", (ev) => {
      const tag = ev.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (ev.key === "ArrowDown") { ev.preventDefault(); this.swipe(-1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); this.swipe(1); }
      else if (ev.key === " ") { ev.preventDefault(); this.player.togglePlay(); this.renderPlayBtn(); }
    });
  }

  /** 阻尼：该方向不可滑时给橡皮筋手感（位移打三折） */
  _damp(dy) {
    const can = dy < 0 ? this.fsm.canSwipeNext() : this.fsm.canSwipePrev();
    return can ? dy * 0.86 : dy * 0.3;
  }

  /** dir: -1 = 上滑（下一个），+1 = 下滑（上一个） */
  swipe(dir) {
    // 上一次切换动画还没结束：立即把它收尾（归位 + opacity 复位），再执行本次。
    // 不能直接丢弃——否则连滑时操作被吞，且 deck 可能停在半透明/半位移的中间态。
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
    switch (this.fsm.state) {
      case STATE.MAIN_QUEUE: return "已经是第一个推荐";
      case STATE.COLLECTION_QUEUE: return "已经是第一集";
      case STATE.STITCH: return "缝合尾巴单向，不支持回看";
      default: return "当前状态不支持上翻";
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

  /** 清掉待执行的动画收尾定时器（打断上一次动画时用） */
  _clearAnim() {
    if (this._t1) { clearTimeout(this._t1); this._t1 = null; }
    if (this._t2) { clearTimeout(this._t2); this._t2 = null; }
  }

  /** 强制收尾：清定时器 + deck 完全归位 + opacity 复位 + 解锁。可重复调用。 */
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
    this._clearAnim();              // 避免残留定时器把 transition 抹掉
    this._busy = false;
    deck.style.transition = "transform .22s cubic-bezier(.22,.61,.36,1)";
    deck.style.transform = "translateY(0)";
    deck.style.opacity = "1";       // 兜底：确保不会停在半透明状态
    setTimeout(() => { deck.style.transition = ""; }, 240);
  }

  _hint(text) {
    const el = this.els.hintSwipe;
    el.textContent = text;
    el.classList.remove("show");
    void el.offsetWidth; // 重启动画
    el.classList.add("show");
  }

  // ============ 渲染 ============
  renderAll() {
    this.renderState(); this.renderMeta(); this.renderRail();
    this.renderControls(); this.renderPanel(); this._syncLoader();
    if (this.els.epPanel.classList.contains("on")) this.renderEpisodes(); // 抽屉开着 → 同步选集列表
  }

  // ============ 手动选集（底部抽屉） ============
  toggleEpisodes(on) {
    this.els.epPanel.classList.toggle("on", on);
    this.els.epMask.classList.toggle("on", on);
    if (on) this.renderEpisodes();
  }

  /** 渲染选集列表：当前集高亮；看完打勾（SVG ✓）；看到一半显示已看进度（元素状态，v1.0 §六） */
  renderEpisodes() {
    const m = this.fsm.model;
    const st = this.fsm.state;
    const cq = m.collectionQueue;
    if (!cq) return;
    const src = activeSource();
    const def = src.getCollectionMeta(cq.collectionId);
    this.els.epTitle.textContent = `选集 · ${def?.title || cq.collectionId}（${cq.items.length} 集）`;
    const inStitch = st === STATE.STITCH;
    const curVid = inStitch ? m.stitch.currentVideoId : m.collectionCurrentVideoId();
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    this.els.epList.innerHTML = cq.items.map((it, i) => {
      const v = src.getVideoMeta(it.videoId);
      // 缝合态当前集的进度在缝合上下文里，其余集读元素自身状态
      const prog = inStitch && it.videoId === m.stitch.currentVideoId ? m.stitch.progressSec : (it.progressSec || 0);
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
    this.els.state.textContent = STATE_LABEL[s] || s;
    this.els.state.className = "badge s-" + s;
  }

  renderMeta() {
    const m = this.fsm.model;
    const src = activeSource();
    const vid = m.currentVideoId();
    const v = src.getVideoMeta(vid);
    const st = this.fsm.state;

    // 分类标签：主队列/降级 = 当前指针项；加载合集 = 进入前的槽位（预支指针不动 UI，
    // 消除「短剧 → 下一项分类 → 短剧/漫剧」的三级跳变）；合集/缝合 = 合集 category
    let cat = "短剧";
    if (st === STATE.MAIN_QUEUE || st === STATE.FALLBACK) {
      cat = m.mainQueue.seed[m.mainQueue.pointer]?.category || "短剧";
    } else if (st === STATE.LOAD_COLLECTION) {
      const at = m.enteredMainIndex >= 0 ? m.enteredMainIndex : m.mainQueue.pointer;
      cat = m.mainQueue.seed[at]?.category || "短剧";
    } else if (st === STATE.COLLECTION_QUEUE) {
      cat = src.getCollectionMeta(m.collectionQueue.collectionId)?.category || "短剧";
    } else if (st === STATE.STITCH) {
      cat = src.getCollectionMeta(m.stitch.collectionId)?.category || "短剧";
    }
    this.els.cat.textContent = cat;
    this.els.title.textContent = v ? v.title : (vid || "—");

    // 副标题：位置信息 + 状态说明
    const mq = m.mainQueue;
    if (st === STATE.COLLECTION_QUEUE) {
      const cq = m.collectionQueue;
      const def = src.getCollectionMeta(cq.collectionId);
      this.els.sub.textContent = `${def?.title || cq.collectionId} · EP ${cq.pointer + 1}/${cq.items.length}`;
    } else if (st === STATE.STITCH) {
      const def = src.getCollectionMeta(m.stitch.collectionId);
      const tail = m.stitchTailLength();
      this.els.sub.textContent = `${def?.title || m.stitch.collectionId} · 续播中 · 尾巴 ${tail} 集${m.stitch.tailLazy ? "（懒恢复）" : ""}`;
    } else if (st === STATE.LOAD_COLLECTION) {
      this.els.sub.textContent = "正在加载分集…";
    } else if (st === STATE.FALLBACK) {
      this.els.sub.textContent = "加载失败，已回推荐流";
    } else {
      this.els.sub.textContent = `第 ${mq.pointer + 1}/${mq.items.length} 个推荐 · 源 ${src.label || src.id}`;
    }

    // 底部提示：随状态变化的滑动语义
    const tip = {
      [STATE.MAIN_QUEUE]: "上滑 → 下一个推荐　下滑 → 上一个推荐",
      [STATE.COLLECTION_QUEUE]: "上滑 → 下一集　下滑 → 上一集",
      [STATE.STITCH]: "上滑 → 尾巴续播下一集（不支持上翻）",
      [STATE.LOAD_COLLECTION]: "加载中…",
      [STATE.FALLBACK]: "已降级，上滑继续浏览推荐",
    }[st] || "";
    this.els.tip.textContent = tip;
  }

  renderRail() {
    const m = this.fsm.model;
    const st = this.fsm.state;
    let total = 0, cur = -1;
    if (st === STATE.COLLECTION_QUEUE) { total = m.collectionQueue.items.length; cur = m.collectionQueue.pointer; }
    else if (st === STATE.STITCH) { total = 1 + m.stitchTailLength(); cur = m.stitchTailLength(); }
    else if (st === STATE.LOAD_COLLECTION) {
      // 加载期间刻度停在「进入前的位置」（预支指针不体现在 UI，不跳格）
      total = m.mainQueue.items.length;
      cur = m.enteredMainIndex >= 0 ? m.enteredMainIndex : m.mainQueue.pointer;
    }
    else { total = m.mainQueue.items.length; cur = m.mainQueue.pointer; }
    if (!total) { this.els.rail.innerHTML = ""; return; }

    // 窗口化：只渲染指针附近最多 railWindow 个刻度
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
    this.els.btnColl.disabled = !(st === STATE.MAIN_QUEUE && seed?.collectionId);
    this.els.btnColl.title = seed?.collectionId ? `连播合集 ${seed.collectionId}` : "当前推荐不属于任何合集";
    this.els.btnExit.disabled = !(st === STATE.COLLECTION_QUEUE || st === STATE.STITCH);
    const exitLabel = st === STATE.STITCH ? "脱离" : "缝合";
    this.els.btnExit.innerHTML = `<svg class="ic"><use href="#i-exit"/></svg><span>${exitLabel}</span>`;
    this.els.btnExit.title = st === STATE.STITCH ? "脱离合集，回到推荐流下一项" : "退出到缝合态（当前集不中断）";
    // 选集仅在合集态 / 缝合态（有合集数据）可用
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
    this.els.pState.textContent = `${st}`;
    this.els.pMain.textContent = `#${m.mainQueue.pointer + 1}/${m.mainQueue.items.length} · ${m.mainCurrentVideoId() || "—"}`;
    this.els.pColl.textContent = m.collectionQueue
      ? `${m.collectionQueue.collectionId} EP${m.collectionQueue.pointer + 1}/${m.collectionQueue.items.length}`
      : "—";
    this.els.pStitch.textContent = m.stitch.active
      ? `${m.stitch.collectionId} · 当前 ${m.stitch.currentVideoId} · 尾巴 ${m.stitchTailLength()} · 槽位 #${m.stitch.replacedIndex + 1}${m.stitch.tailLazy ? " · 懒恢复" : ""}`
      : "未激活";
    const c = this.preload.current;
    this.els.pPre.textContent = c ? `${c.videoId} · ${c.level} · ${c.state}` : "无目标";
  }

  // ============ 配置热调（预加载组：事件回调热读，改后即时生效） ============
  _bindConfig() {
    const KB = 1024;
    // 仅暴露「运行时热读」项（preload 仲裁每次读取 CONFIG.preload）；其余配置见 src/config.js
    const fields = [
      ["cfgPreloadEnabled",      "enabled",            (v) => !!v],
      ["cfgTriggerRemainingSec", "triggerRemainingSec",(v) => Number(v)],
      ["cfgTriggerRatio",        "triggerRatio",       (v) => Number(v)],
      ["cfgMinSinceStartSec",    "minSinceStartSec",   (v) => Number(v)],
      ["cfgPreloadBytesL2",      "preloadBytesL2",     (v) => Math.round(v / KB)],
      ["cfgPreloadBytesL3",      "preloadBytesL3",     (v) => Math.round(v / KB)],
    ];
    this._cfgDefaults = {};        // 构造时快照的默认值（重置用）
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
