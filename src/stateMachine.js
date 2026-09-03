// stateMachine.js · 调度状态机内核（v1.0 §4 唯一真相源）
//
// 转换表（v1.0 §4.2 状态转换表）直接映射为代码里的唯一真相源。
// 输入事件（播放器/用户原始事实）进状态机裁决；裁决后的输出事件上 QueueEvent 总线。
// 订阅者只读总线，不回流——保证转换表不被表外转换破坏（ADR-10 §4.1）。

import { STATE, QueueModel, makeItem } from "./queueModel.js";
import { EVENT } from "./eventBus.js";
import { CONFIG } from "./config.js";
import { registry, activeSource } from "./sources/index.js";

// 输入事件（内部，进状态机；不上总线）
const INPUT = {
  ITEM_ENDED: "ITEM_ENDED",
  ENTER_COLLECTION: "ENTER_COLLECTION",
  EXIT_COLLECTION: "EXIT_COLLECTION",
  SWITCH_MAIN_NEXT: "SWITCH_MAIN_NEXT",
  SWITCH_MAIN_PREV: "SWITCH_MAIN_PREV",  // 下滑：回主队列上一项（不消费）
  SWITCH_COLL_NEXT: "SWITCH_COLL_NEXT",  // 上滑：切合集下一集
  SWITCH_COLL_PREV: "SWITCH_COLL_PREV",  // 下滑：回合集上一集（不消费）
  SELECT_EPISODE: "SELECT_EPISODE",      // 手动选集：跳到合集第 N 集
};

// 转换表：(state, input) -> action 名。动态目标由 action 自行返回。
const TABLE = {
  [STATE.MAIN_QUEUE]: {
    [INPUT.ITEM_ENDED]: "mainItemEnded",
    [INPUT.ENTER_COLLECTION]: "enterCollection",
    [INPUT.SWITCH_MAIN_NEXT]: "mainSwitchNext",
    [INPUT.SWITCH_MAIN_PREV]: "mainSwitchPrev",
  },
  [STATE.LOAD_COLLECTION]: {
    LOAD_SUCCESS: "onLoadSuccess",
    LOAD_RETRY: "onLoadRetry",
    LOAD_FAIL: "onLoadFail",
    LOAD_EMPTY: "onLoadEmpty",
  },
  [STATE.COLLECTION_QUEUE]: {
    [INPUT.ITEM_ENDED]: "collItemEnded",
    [INPUT.EXIT_COLLECTION]: "collExitToStitch",
    [INPUT.SWITCH_COLL_NEXT]: "collSwitchNext",
    [INPUT.SWITCH_COLL_PREV]: "collSwitchPrev",
    [INPUT.SELECT_EPISODE]: "collJumpEpisode",
  },
  [STATE.STITCH]: {
    [INPUT.ITEM_ENDED]: "stitchItemEnded",
    [INPUT.SWITCH_MAIN_NEXT]: "stitchSwitchMain",
    [INPUT.SWITCH_COLL_NEXT]: "stitchSwitchNext",  // 上滑：沿尾巴推进一集
    [INPUT.SELECT_EPISODE]: "stitchJumpEpisode",   // 手动选集：跳转并重铺尾巴
    [INPUT.ENTER_COLLECTION]: "stitchEnterCollection",
  },
  [STATE.FALLBACK]: {
    RECOVERED: "fallbackRecovered",
  },
};

export class QueueFSM {
  constructor(bus, source = activeSource()) {
    this.bus = bus;
    this._source = source;        // 当前视频源（来自兼容层注册表）
    this._seed = [];              // 当前主队列规范元素（来自 source.listMainQueue）
    this.model = new QueueModel([]);
    this.model.state = STATE.MAIN_QUEUE;
    this._enteredMainIndex = -1; // 进入合集时主队列被替换的槽位
    this._collPlayedCount = 0;    // 本次合集累计观看集数
    this._tailConsumed = 0;       // 缝合态已消费尾巴集数
    this._refreshLast = 0;        // 上次主队列刷新时间
    this._refreshPending = null;  // 缝合态挂起的刷新请求
    this._refreshBoundary = null; // 播放中推迟到项边界执行的刷新
    this._resumePending = null;   // 历史续播目标（进入合集后 onLoadSuccess 据此定位集数 + 进度）
    this.networkLevel = "wifi";    // 演示：默认 Wi-Fi（L3 可用）
  }

  get state() { return this.model.state; }

  /** 从当前视频源异步拉取主队列并构建模型（boot 时调用一次） */
  async init() {
    this._seed = await this._source.listMainQueue();
    this.model.mainRebuild(this._seed);
    this.bus.emit(EVENT.PROVIDER_READY, { source: this._source.id });
    return this;
  }

  // —— 通用迁移：先更新 state 再广播（订阅者读到的是新状态，避免渲染滞后一拍）——
  _transition(to, reason) {
    const from = this.model.state;
    this.model.state = to;                                   // 先落定新状态
    this.bus.emit(EVENT.STATE_CHANGED, { from, to, reason }); // 再广播（payload 的 to 即新状态）
    // 项边界到达时，若有推迟到边界的刷新，执行
    if (from !== to && this._refreshBoundary) {
      const r = this._refreshBoundary; this._refreshBoundary = null;
      this._executeRefresh(r.trigger, r.force);
    }
  }

  // ============ 输入入口（播放器 / UI 调用） ============
  playbackEnded() { return this._dispatch(INPUT.ITEM_ENDED); }
  exitCollection() { return this._dispatch(INPUT.EXIT_COLLECTION); }
  switchToNextMain() { return this._dispatch(INPUT.SWITCH_MAIN_NEXT); }

  // ============ 滑动输入（竖屏 UI 上滑/下滑） ============
  // 返回 true=已切换，false=到底/到顶（UI 据此做阻尼回弹与 toast）
  //
  //  主队列       上滑 → 消费当前，前进到下一个推荐（到底则续拉）
  //               下滑 → 回上一个推荐（不消费，可再看）
  //  合集队列     上滑 → 下一集；末集上滑 = 播完，自动回主队列
  //               下滑 → 上一集（不消费，首集到底）
  //  缝合态       上滑 → 沿尾巴续播下一集；尾巴尽则脱离回主队列
  //               下滑 → 尾巴单向，不支持回看（返回 false）
  swipeNext() {
    switch (this.model.state) {
      case STATE.MAIN_QUEUE: return this._dispatch(INPUT.SWITCH_MAIN_NEXT);
      case STATE.COLLECTION_QUEUE:
      case STATE.STITCH: return this._dispatch(INPUT.SWITCH_COLL_NEXT);
      default: return false; // LoadCollection / Fallback 期间不响应滑动
    }
  }
  swipePrev() {
    switch (this.model.state) {
      case STATE.MAIN_QUEUE: return this._dispatch(INPUT.SWITCH_MAIN_PREV);
      case STATE.COLLECTION_QUEUE: return this._dispatch(INPUT.SWITCH_COLL_PREV);
      case STATE.STITCH: return false; // 尾巴单向：不支持回看
      default: return false;
    }
  }
  /** 供 UI 决定是否显示「没有更多」提示（不做转换，纯查询） */
  canSwipeNext() { return [STATE.MAIN_QUEUE, STATE.COLLECTION_QUEUE, STATE.STITCH].includes(this.model.state); }
  canSwipePrev() {
    switch (this.model.state) {
      case STATE.MAIN_QUEUE: return this.model.mainQueue.pointer > 0;
      case STATE.COLLECTION_QUEUE: return !!this.model.collectionQueue && this.model.collectionQueue.pointer > 0;
      default: return false; // 缝合态尾巴单向 + 加载/降级态不响应
    }
  }

  /** 进入合集：进入槽位 = 当前指针项（调用方语义）。
   *  「用户主动点击队列元素」的场景（deepLink/宫格/历史续播）应先经 switchToMainIndex
   *  把指针指向被点击项，再调本方法——指针指向谁，合集就替换谁（单一真相源）。 */
  enterCollection(collectionId, entrySource = "playAll") {
    // STITCH 态下重入：同一合集忽略（ADR-6）；另一合集先清除缝合态（5.2）
    if (this.model.stitch.active) {
      if (this.model.stitch.collectionId === collectionId) {
        this.bus.emit(EVENT.STITCH_TAIL_ADVANCED, { episodeIndex: -1, ignored: true });
        console.info("[FSM] 缝合态重入同一合集 → 忽略（ADR-6）");
        return;
      }
      this.model.stitchClear(); // 切到另一合集，先清除当前缝合态（替换已永久生效）
    }
    this._enteredMainIndex = this.model.mainQueue.pointer; // 当前正在看的元素（指针=当前元素）
    this.model.enteredMainIndex = this._enteredMainIndex;   // 加载期间继续显示该项
    // 不预支：主队列指针保持指向当前元素。合集/缝合态期间该槽位即「正在看的角色」，
    // 退出后从此元素继续；前进只发生在用户主动上滑或独立短视频播完消费时。
    this._collPlayedCount = 0;
    this._transition(STATE.LOAD_COLLECTION, "enter-collection");
    this._loadCollection(collectionId, entrySource);
  }

  // 播放进度（用于缝合态懒恢复尾巴 + 预加载 + 元素进度回写 + 播放记录，player 调用）
  onProgress(currentSec, durationSec, remainingSec, ratio) {
    // v1.0 §六：队列元素保留播放状态——把当前播放位置写回当前元素（内核统一写，单一真相源）
    const st = this.model.state;
    const item = st === STATE.MAIN_QUEUE || st === STATE.FALLBACK
      ? this.model.mainCurrent()
      : st === STATE.LOAD_COLLECTION
        ? (this.model.mainQueue.items[this.model.enteredMainIndex] || null)
        : st === STATE.COLLECTION_QUEUE
          ? this.model.collectionCurrent()
          : null;
    if (item) {
      item.progressSec = currentSec;
      if (durationSec) item.durationSec = durationSec;
    } else if (st === STATE.STITCH) {
      this.model.stitch.progressSec = currentSec; // 缝合态当前集不在队列元素上，记在缝合上下文
    }
    const stitchCtx = this.model.stitch;
    if (st === STATE.STITCH && stitchCtx.active && stitchCtx.tailLazy) {
      if (remainingSec <= 5 || ratio >= 0.8) {
        this._loadStitchTailLazy();
      }
    }
    // 播放记录：节流广播当前集进度（供 history / 其它持久化订阅者只读消费）
    // 时间戳记在 FSM 实例上：model.state 是字符串（状态名），挂属性在严格模式下会抛 TypeError
    const now = Date.now();
    if (!this._progressEmitAt || now - this._progressEmitAt >= 4000) {
      this._progressEmitAt = now;
      const videoId = this.model.currentVideoId();
      if (videoId) {
        // 标题/封面/集号只存在于数据源的规范条目里：队列 items 只带 videoId + 播放状态，
        // 直接从 items 上取会全部拿到 undefined（历史记录会退化成显示 videoId）。
        const meta = this._source?.getVideoMeta?.(videoId) || null;
        const cq = this.model.collectionQueue;
        const collectionId =
          (st === STATE.STITCH && stitchCtx.active ? stitchCtx.collectionId : null)
          || (cq && cq.items.some((i) => i.videoId === videoId) ? cq.collectionId : null)
          || meta?.collectionId || null;
        this.bus.emit(EVENT.PROGRESS_UPDATE, {
          videoId, sourceId: this._source?.id || null,
          progressSec: currentSec, durationSec: durationSec || null, ratio,
          watched: !!(durationSec && currentSec >= durationSec - 1),
          collectionId,
          episodeIndex: meta?.episodeIndex ?? null,
          title: meta?.title || null,
          poster: meta?.poster || null,
          category: meta?.category || null,
        });
      }
    }
  }

  /** 查询某视频的续播位置（秒）。播完的从头；无记录返回 0。回看/选集/冷恢复时由播放器调用。 */
  getResumePosition(videoId) {
    if (!videoId) return 0;
    const m = this.model;
    const cq = m.collectionQueue;
    // 同一 videoId 可能同时存在于主队列与合集（进入合集前的残留）——
    // 合集态/缝合态下权威记录是合集元素（onProgress 写的就是它），优先取；
    // 其余态优先主队列元素，合集元素仅作兜底（如冷恢复边缘场景）。
    const inCollectionCtx = (m.state === STATE.COLLECTION_QUEUE || m.state === STATE.STITCH) && cq;
    let item = inCollectionCtx ? cq.items.find((i) => i.videoId === videoId) : null;
    if (!item) item = m.mainQueue.items.find((i) => i.videoId === videoId);
    if (!item && cq) item = cq.items.find((i) => i.videoId === videoId);
    let progress = item ? item.progressSec : null;
    let duration = item ? item.durationSec : null;
    if (videoId === m.stitch.currentVideoId && m.stitch.active) {
      progress = m.stitch.progressSec; // 缝合当前集的实时进度在上下文里（比元素记录新）
      duration = duration || (cq?.items.find((i) => i.videoId === videoId)?.durationSec ?? null);
    }
    if (!progress || progress <= 3) return 0; // 太短的进度不续播，直接从头
    if (duration && progress >= duration - 1) return 0; // 已播完 → 从头
    return progress;
  }

  // ============ 合集加载（异步，经兼容层） ============
  async _loadCollection(collectionId, entrySource, retry = 0) {
    try {
      const { items, startPointer } = await this._source.listCollection(collectionId);
      if (items.length === 0) {
        this._dispatchInternal("LOAD_EMPTY", { collectionId });
      } else {
        this._pendingItems = items.map((i) => i.videoId); // 归一化后的 videoId 列表
        this._pendingStart = startPointer;                 // 历史定位的起始指针
        this._dispatchInternal("LOAD_SUCCESS", { collectionId, startPointer });
      }
    } catch (err) {
      if (retry < CONFIG.api.maxRetry) {
        setTimeout(() => this._loadCollection(collectionId, entrySource, retry + 1), CONFIG.api.retryMs);
        this._dispatchInternal("LOAD_RETRY", { collectionId, retry });
      } else {
        this._dispatchInternal("LOAD_FAIL", { collectionId, reason: err.message });
      }
    }
  }

  // ============ 内部派发（含异步结果事件） ============
  _dispatchInternal(internalEvent, payload = {}) {
    const action = TABLE[this.model.state]?.[internalEvent];
    if (!action) {
      console.warn(`[FSM] 非法/未定义迁移: ${this.model.state} --${internalEvent}--> ?`);
      return false;
    }
    const r = this[action](payload);
    return r === undefined ? true : r;
  }

  _dispatch(input) {
    const action = TABLE[this.model.state]?.[input];
    if (!action) {
      // 表外转换：丢弃并记埋点（ADR-10 §4.2）
      console.warn(`[FSM] 丢弃表外转换: ${this.model.state} --${input}-->`);
      this.bus.emit(EVENT.FALLBACK_TRIGGERED, { scene: "illegal-transition", reason: `${this.model.state}/${input}`, retryCount: 0 });
      return false;
    }
    const r = this[action]();
    return r === undefined ? true : r; // 缺省视为成功切换
  }

  // ============ 动作实现 ============
  /** 主队列自然播完：刷剧场景——不再消费前进，而是自动进入当前推荐位所属合集。
   *  无合集的独立短片才回退到「消费前进」的旧语义（耗尽则追加）。 */
  mainItemEnded() {
    const cur = this.model.mainCurrent();
    if (cur) { cur.state = "played"; cur.progressSec = 0; } // 播完：进度归零（下次从头）
    const vid = cur ? cur.videoId : null;
    this.bus.emit(EVENT.ITEM_CONSUMED, { videoId: vid, queueType: "main", by: "playout" });
    const seed = this.model.mainQueue.seed[this.model.mainQueue.pointer];
    const colId = seed?.collectionId;
    if (colId) {
      // 刷剧：主队列只是「发现入口」，播完即进合集连播（不消费、不预支——合集退出后再回到此处）
      this.enterCollection(colId, "autoEnter");
      return true;
    }
    // 独立短片：无合集可进 → 消费前进（ADR-1）；耗尽则追加（非刷新，ADR-11 §5.1）
    this._advanceMainOrAppend();
    this._transition(STATE.MAIN_QUEUE, "item-ended");
    return true;
  }

  mainSwitchNext() {
    const cur = this.model.mainCurrent();
    if (cur) cur.state = "played";
    const vid = cur ? cur.videoId : null;
    this.bus.emit(EVENT.ITEM_CONSUMED, { videoId: vid, queueType: "main", by: "manual" });
    this._advanceMainOrAppend();
    this._transition(STATE.MAIN_QUEUE, "switch-next");
    return true;
  }

  /** 下滑：回主队列上一项（不消费——回看不算看完，指针回退后状态复位为 unplayed） */
  mainSwitchPrev() {
    const mq = this.model.mainQueue;
    if (mq.pointer <= 0) return false;            // 已在首项，无上一项
    mq.pointer--;
    const cur = this.model.mainCurrent();
    if (cur) cur.state = "unplayed";              // 不消费：允许再次下滑/重播
    this._transition(STATE.MAIN_QUEUE, "switch-prev");
    return true;
  }

  _advanceMainOrAppend() {
    const mq = this.model.mainQueue;
    const next = mq.pointer + 1;
    if (next >= mq.items.length) {
      const oldLen = mq.items.length;
      this._appendFeed();               // 翻到底续拉（追加）
      // 无新增（缓冲空）→ 停在末项，避免指针越界
      mq.pointer = oldLen < mq.items.length ? oldLen : mq.items.length - 1;
    } else {
      mq.pointer = next;
    }
  }

  onLoadSuccess({ collectionId, startPointer }) {
    this.model.collectionLoad(this._pendingItems, startPointer, collectionId);
    // 历史续播：加载完成后定位到记录所在集并从进度续播（覆盖源的历史定位指针）
    const resume = this._resumePending;
    this._resumePending = null;
    const cq = this.model.collectionQueue;
    let startEpisodeIndex = cq.pointer;
    if (resume) {
      let idx = resume.episodeIndex != null ? resume.episodeIndex : -1;
      if (idx < 0 || idx >= cq.items.length) idx = cq.items.findIndex((i) => i.videoId === resume.videoId);
      if (idx >= 0) {
        cq.pointer = idx;
        startEpisodeIndex = idx;
        const it = cq.items[idx];
        it.state = "playing";
        if (resume.progressSec > 3) it.progressSec = resume.progressSec;
        if (resume.durationSec) it.durationSec = resume.durationSec;
      }
    }
    this.bus.emit(EVENT.COLLECTION_ENTERED, {
      collectionId, startEpisodeIndex, pointerSource: "history",
    });
    this._transition(STATE.COLLECTION_QUEUE, "load-success");
  }

  onLoadRetry({ collectionId, retry }) {
    this.bus.emit(EVENT.FALLBACK_TRIGGERED, { scene: "loadCollection", reason: "timeout", retryCount: retry });
    // 静默重试：停留在 LOAD_COLLECTION，不降级
  }

  onLoadFail({ collectionId, reason }) {
    this.bus.emit(EVENT.FALLBACK_TRIGGERED, { scene: "loadCollection", reason: "error", retryCount: CONFIG.api.maxRetry });
    this._transition(STATE.FALLBACK, "load-fail");
    this._recover();
  }

  onLoadEmpty({ collectionId }) {
    this.bus.emit(EVENT.FALLBACK_TRIGGERED, { scene: "loadCollection", reason: "empty", retryCount: 0 });
    this._transition(STATE.FALLBACK, "load-empty");
    this._recover();
  }

  _recover() {
    // 降级回主队列：从当前元素继续（指针=当前元素，4.2：恢复主队列指针）
    setTimeout(() => {
      this.bus.emit(EVENT.MAIN_QUEUE_REFRESHED, { trigger: "fallback", anchorPreserved: false });
      this._transition(STATE.MAIN_QUEUE, "recovered");
    }, 300);
  }

  collItemEnded() {
    const cur = this.model.collectionCurrent();
    if (cur) { cur.state = "played"; cur.progressSec = 0; } // 播完：进度归零（回看从头）
    const vid = cur ? cur.videoId : null;
    this._collPlayedCount++;
    if (this.model.collectionIsLast()) {
      // 末集播完 → 自动退出，无缝回主队列指针（ADR-2）
      this.bus.emit(EVENT.COLLECTION_EXITED, {
        collectionId: this.model.collectionQueue.collectionId,
        exitType: "autoFinish", playedEpisodes: this._collPlayedCount,
      });
      this.bus.emit(EVENT.ITEM_CONSUMED, { videoId: vid, queueType: "collection", by: "playout" });
      this.model.collectionQueue = null;
      this._transition(STATE.MAIN_QUEUE, "auto-finish");
    } else {
      this.model.collectionAdvance();
      this.bus.emit(EVENT.ITEM_CONSUMED, { videoId: vid, queueType: "collection", by: "playout" });
      this._transition(STATE.COLLECTION_QUEUE, "item-ended");
    }
    return true;
  }

  /** 上滑：切合集下一集。末集上滑 = 与「播完」同语义 → 自动完成退出（ADR-2） */
  collSwitchNext() {
    const cur = this.model.collectionCurrent();
    const vid = cur ? cur.videoId : null;
    if (cur) cur.state = "played";
    this._collPlayedCount++;
    if (this.model.collectionIsLast()) {
      this.bus.emit(EVENT.COLLECTION_EXITED, {
        collectionId: this.model.collectionQueue.collectionId,
        exitType: "autoFinish", playedEpisodes: this._collPlayedCount,
      });
      this.bus.emit(EVENT.ITEM_CONSUMED, { videoId: vid, queueType: "collection", by: "swipe" });
      this.model.collectionQueue = null;
      this._transition(STATE.MAIN_QUEUE, "auto-finish");
      return true;
    }
    this.model.collectionAdvance();
    this.bus.emit(EVENT.ITEM_CONSUMED, { videoId: vid, queueType: "collection", by: "swipe" });
    this._transition(STATE.COLLECTION_QUEUE, "switch-next");
    return true;
  }

  /** 下滑：回合集上一集（不消费，可再滑回来） */
  collSwitchPrev() {
    const cq = this.model.collectionQueue;
    if (!cq || cq.pointer <= 0) return false;     // EP1 已是首集
    cq.pointer--;
    const cur = this.model.collectionCurrent();
    if (cur) cur.state = "unplayed";              // 不消费：回看的集不计入已播
    this._collPlayedCount = Math.max(0, this._collPlayedCount - 1);
    this._transition(STATE.COLLECTION_QUEUE, "switch-prev");
    return true;
  }

  /** 手动选集：合集态跳到第 index 集（0 基）。当前集元素不动（进度保留在元素上），只挪指针 */
  collJumpEpisode(index) {
    const cq = this.model.collectionQueue;
    if (!cq || !Number.isInteger(index) || index < 0 || index >= cq.items.length) return false;
    if (index === cq.pointer) return true;        // 已在该集
    cq.pointer = index;
    this.bus.emit(EVENT.COLLECTION_ENTERED, {
      collectionId: cq.collectionId, startEpisodeIndex: index, pointerSource: "manualJump",
    });
    this._transition(STATE.COLLECTION_QUEUE, "jump-episode");
    return true;
  }

  /** 手动选集：缝合态跳转——当前集切到目标集，尾巴重铺为目标集之后的合集剩余 */
  stitchJumpEpisode(index) {
    const cq = this.model.collectionQueue;
    const st = this.model.stitch;
    if (!cq || !st.active || !Number.isInteger(index) || index < 0 || index >= cq.items.length) return false;
    const vid = cq.items[index].videoId;
    if (vid === st.currentVideoId) return true;   // 已在该集
    // 旧当前集的进度落回其合集元素（元素保留状态，v1.0 §六）
    const curIdx = cq.items.findIndex((i) => i.videoId === st.currentVideoId);
    if (curIdx >= 0 && st.progressSec > 0) {
      cq.items[curIdx].progressSec = st.progressSec;
      cq.items[curIdx].state = "playing";
    }
    const tail = cq.items.slice(index + 1).map((i) => ({
      videoId: i.videoId, state: i.state, progressSec: i.progressSec, durationSec: i.durationSec,
    }));
    this.model.stitchEnter(vid, tail, st.replacedIndex, st.collectionId, false, cq.items[index].progressSec || 0);
    cq.pointer = index;
    this.bus.emit(EVENT.STITCH_ENTERED, {
      collectionId: st.collectionId, episodeIndex: index, tailLength: tail.length, jumped: true,
    });
    this._transition(STATE.STITCH, "jump-episode");
    return true;
  }

  /** 手动选集入口（UI 调用）。合集态/缝合态可跳，其余态返回 false */
  jumpToEpisode(index) {
    switch (this.model.state) {
      case STATE.COLLECTION_QUEUE:
      case STATE.STITCH:
        return this._dispatchInternal(INPUT.SELECT_EPISODE, index);
      default:
        return false;
    }
  }
  canJumpEpisode() {
    return (this.model.state === STATE.COLLECTION_QUEUE && !!this.model.collectionQueue)
      || (this.model.state === STATE.STITCH && this.model.stitch.active && !!this.model.collectionQueue);
  }

  collExitToStitch() {
    const cq = this.model.collectionQueue;
    const curVid = this.model.collectionCurrentVideoId();
    const idx = cq.pointer;
    const tail = cq.items.slice(idx + 1).map((i) => ({ videoId: i.videoId, state: "unplayed" }));
    // 主队列替换：当前合集首集 → 实际播放集（永久生效，ADR-4）
    const anchorVideoId = this.model.mainQueue.items[this._enteredMainIndex]?.videoId; // 替换前的原槽位
    const replaced = this.model.mainReplace(this._enteredMainIndex, curVid);
    this.bus.emit(EVENT.MAIN_QUEUE_REPLACED, {
      anchorVideoId,
      replacedVideoId: curVid, ok: replaced,
    });
    // 进入缝合态：当前集不中断，播完沿尾巴继续（ADR-3）
    this.model.stitchEnter(curVid, tail, this._enteredMainIndex, cq.collectionId, false);
    this.bus.emit(EVENT.STITCH_ENTERED, {
      collectionId: cq.collectionId, episodeIndex: idx, tailLength: tail.length,
    });
    this.bus.emit(EVENT.COLLECTION_EXITED, {
      collectionId: cq.collectionId, exitType: "exitToStitch", playedEpisodes: this._collPlayedCount,
    });
    this._tailConsumed = 0;
    this._transition(STATE.STITCH, "exit-to-stitch");
    return true;
  }

  stitchItemEnded(by = "playout") {
    const curVid = this.model.stitch.currentVideoId;
    if (this.model.stitchTailLength() > 0) {
      this.model.stitchTailAdvance();
      this._tailConsumed++;
      this.bus.emit(EVENT.STITCH_TAIL_ADVANCED, {
        episodeIndex: -1, // 尾巴来自合集，下标无意义
        tailConsumed: this._tailConsumed,
      });
      this.bus.emit(EVENT.ITEM_CONSUMED, { videoId: curVid, queueType: "tail", by });
      this._transition(STATE.STITCH, "tail-advanced");
    } else {
      // 尾巴播完 → 脱离合集，回主队列（tailFinished）
      this.bus.emit(EVENT.STITCH_EXITED, { exitType: "tailFinished", tailConsumed: this._tailConsumed });
      this.bus.emit(EVENT.ITEM_CONSUMED, { videoId: curVid, queueType: "tail", by });
      this.model.collectionQueue = null;
      this.model.stitchClear();
      this._transition(STATE.MAIN_QUEUE, "tail-finished");
    }
    return true;
  }

  /** 上滑：缝合态沿尾巴续播下一集（尾巴尽则脱离回主队列） */
  stitchSwitchNext() { return this.stitchItemEnded("swipe"); }

  stitchSwitchMain() {
    // 用户主动切主队列下一项 → 立即脱离合集（consumeMainItem）
    this.bus.emit(EVENT.STITCH_EXITED, { exitType: "consumeMainItem", tailConsumed: this._tailConsumed });
    this.model.collectionQueue = null;
    this.model.stitchClear();
    this._transition(STATE.MAIN_QUEUE, "consume-main");
  }

  stitchEnterCollection({ collectionId, entrySource }) {
    // 同一合集已在上面 enterCollection 入口忽略；此处为「另一合集」路径（已 stitchClear）
    this._loadCollection(collectionId, entrySource);
  }

  fallbackRecovered() {
    this._transition(STATE.MAIN_QUEUE, "recovered");
  }

  // ============ 缝合态懒恢复（ADR-8） ============
  async _loadStitchTailLazy() {
    const st = this.model.stitch;
    st.tailLazy = false;
    try {
      const { items } = await this._source.listCollection(st.collectionId);
      const curIdx = items.findIndex((it) => it.videoId === st.currentVideoId);
      // 重铺尾巴时保留各元素已有的播放状态（v1.0 §六：元素状态不因懒恢复丢失）
      const old = new Map((this.model.collectionQueue?.items || []).map((i) => [i.videoId, i]));
      const tail = items.slice(curIdx + 1).map((it) => {
        const prev = old.get(it.videoId);
        return { videoId: it.videoId, state: prev?.state || "unplayed", progressSec: prev?.progressSec || 0, durationSec: prev?.durationSec ?? null };
      });
      st.remainingTail = tail;
    } catch (e) {
      // 尾巴重取失败 → 降级为主队列续播（ADR-8 §2.4）
      console.warn("[FSM] 缝合尾巴重取失败，降级主队列续播");
      this.bus.emit(EVENT.FALLBACK_TRIGGERED, { scene: "recoverTail", reason: e.message, retryCount: 0 });
      this.model.collectionQueue = null;
      this.model.stitchClear();
      this._transition(STATE.MAIN_QUEUE, "tail-recover-fail");
    }
  }

  /** 冷启动从快照恢复缝合态（由 snapshot 模块在 boot 时调用） */
  recoverStitch(snapshot) {
    const idx = this.model.mainQueue.items.findIndex(
      (it) => it.videoId === snapshot.mainAnchorVideoId
    );
    if (idx >= 0) this.model.mainReplace(idx, snapshot.replacedVideoId);
    // 快照携带缝合当前集进度 → 恢复后从该进度续播（v1.0 §五：回来继续从当前进度播放）
    this.model.stitchEnter(snapshot.currentVideoId, [], idx, snapshot.collectionId, true, snapshot.currentProgressSec || 0);
    this._enteredMainIndex = idx;
    this.model.enteredMainIndex = idx;
    // 指针=当前元素：恢复后停在当前元素（快照进入合集的槽位），不自预支跳过
    if (idx >= 0) this.model.mainQueue.pointer = idx;
    this._tailConsumed = 0;
    this._transition(STATE.STITCH, "recover"); // 发出 StateChanged，播放器据此加载
    this.bus.emit(EVENT.STITCH_ENTERED, {
      collectionId: snapshot.collectionId, episodeIndex: snapshot.currentEpisodeIndex,
      tailLength: 0, recovered: true,
    });
  }

  // ============ 主队列刷新（ADR-11） ============
  requestRefresh(trigger, { force = false } = {}) {
    const now = Date.now();
    // 冷却窗口（用户主动/服务端强制豁免）
    if (!force && now - this._refreshLast < CONFIG.refresh.cooldownMs) {
      console.info("[FSM] 主队列刷新冷却中，已丢弃");
      this.bus.emit(EVENT.MAIN_QUEUE_REFRESHED, { trigger, anchorPreserved: false, dropped: true });
      return;
    }
    // 缝合态挂起最优先（5.4）：挂起为 pending，脱离后第一个项边界执行
    if (this.model.stitch.active) {
      this._refreshPending = { trigger, until: now + CONFIG.refresh.pendingTtlMs };
      console.info("[FSM] 刷新挂起（缝合态中），脱离后执行");
      this.bus.emit(EVENT.MAIN_QUEUE_REFRESHED, { trigger, anchorPreserved: false, pendingHeld: true });
      return;
    }
    // 正在播放 → 推迟到当前项播完（项边界执行，不打断，5.4）
    const playing = [STATE.COLLECTION_QUEUE, STATE.STITCH].includes(this.model.state);
    if (playing) {
      this._refreshBoundary = { trigger, force };
      console.info("[FSM] 刷新推迟至项边界执行");
      return;
    }
    this._executeRefresh(trigger, force);
  }

  _executeRefresh(trigger, force) {
    const anchor = this.model.lastReplacedVideoId;
    const before = this.model.mainQueue.items.map((i) => i.videoId);
    this.model.mainRebuild(this._seed); // 用兼容层当前主队列规范元素整体刷新
    // 锚点保留：刷新后替换锚仍在新列表 → 替换关系延续；否则自然消亡
    const anchorInNew = anchor && this.model.mainQueue.items.some((i) => i.videoId === anchor);
    if (this._refreshPending && this._refreshPending.until < Date.now()) this._refreshPending = null;
    this._refreshPending = null;
    this._refreshLast = Date.now();
    this.bus.emit(EVENT.MAIN_QUEUE_REFRESHED, { trigger, anchorPreserved: !!anchorInNew, force });
    console.info(`[FSM] 主队列整体刷新完成 trigger=${trigger} anchorPreserved=${!!anchorInNew}`);
  }

  /** 翻到底续拉（追加，非刷新，ADR-11 §5.1），数据来自兼容层 */
  _appendFeed() {
    const extra = this._source.appendMainQueue(this.model.mainQueue.items.length);
    if (!extra.length) return;
    const mq = this.model.mainQueue;
    const exist = new Set(mq.items.map((i) => i.videoId));
    let added = 0;
    for (const e of extra) {
      if (!e?.videoId || exist.has(e.videoId)) continue; // 去重：同一部剧不重复入队
      exist.add(e.videoId);
      mq.items.push(makeItem(e.videoId)); // 带播放状态字段的规范元素（v1.0 §六）
      mq.seed.push(e); // 同步扩展 seed：保留 category/collectionId（UI 分类标签与进合集入口依赖）
      added++;
    }
    if (added) console.info(`[FSM] 主队列追加 ${added} 条（append，非刷新）via source=${this._source.id}`);
  }

  /** 物化完整发现流到主队列（供宫格等全量视图）：循环续拉直至缓冲耗尽。
   *  与滑动触底 append 同语义，仅提前预填，不改播放/进度语义。 */
  materializeFeed() {
    let guard = 0;
    while (guard++ < 30) {
      const before = this.model.mainQueue.items.length;
      this._appendFeed();
      if (this.model.mainQueue.items.length === before) break;
    }
  }

  // ============ 视频源切换（兼容层） ============
  /** 运行时切换视频源：重建主队列、清空合集/缝合态，回到主队列。
   *  切换即生效：即便后端未配置 baseUrl / 同源代理导致主队列加载失败，也允许选中该源
   *  （模型置空主队列回到 MAIN_QUEUE，UI 可见该源被激活），避免「无法切换源」。
   *  仅对未注册的未知源返回 ok:false。快速连续切换用序号守卫丢弃被超越的旧结果。
   *  返回 { ok, failed, stale, error }：ok=源是否被选中；failed=选中后主队列是否加载失败；
   *  stale=已被更新的切换取代（调用方可忽略）。 */
  async switchSource(id) {
    if (!registry.use(id)) { console.warn("[FSM] 未知视频源:", id); return { ok: false, failed: false, stale: false, error: "未知视频源" }; }
    const src = registry.active();
    this._switchSeq = (this._switchSeq || 0) + 1; // 切换序号：完成后校验，已被更新的切换超越则作废
    const seq = this._switchSeq;
    let seed = [];
    let error = null;
    // 注意：不要在这里提前执行 this._source = src。异步拉取主队列存在时间窗，
    // 间隙内旧视频仍在播，onProgress 会用 this._source 的 id 刷新播放记录——
    // 若提前切源会把「正在播的旧源记录」错误记到新源（跨源续播时因此误判同源、不再切源）。
    // 因此等主队列数据就绪（mainRebuild 前）再落定 this._source。
    try {
      seed = await src.listMainQueue();
    } catch (e) {
      // 主队列加载失败：仍完成切换（源被选中），加载失败信息随返回与事件广播，供 UI 引导填 baseUrl
      error = e;
      console.warn(`[FSM] 切源 ${src.id} 主队列加载失败（仍切换，可在「源设置」为该源配置 baseUrl）:`, e.message);
    }
    if (seq !== this._switchSeq) return { ok: false, failed: false, stale: true, error: "stale" }; // 已被更新的切换取代：丢弃旧结果
    this._source = src;
    this._seed = seed;
    this.model.mainRebuild(seed);
    this.model.collectionQueue = null;
    this.model.stitchClear();
    this._enteredMainIndex = -1;
    this._collPlayedCount = 0;
    this._tailConsumed = 0;
    this._refreshPending = null;
    this._refreshBoundary = null;
    this._transition(STATE.MAIN_QUEUE, "source-switch");
    this.bus.emit(EVENT.PROVIDER_READY, {
      source: src.id, switched: true, failed: !!error, error: error?.message || null,
    });
    return { ok: true, failed: !!error, stale: false, error: error?.message || null };
  }

  // ============ 搜索（源按各自语义搜索 + 解析） ============
  /** 搜索当前视频源：结果作为新的主队列进入（可浏览 / 进入合集 / 播放）。
   *  源未实现 search 或无可搜能力时返回 false。搜索不持久化，刷新后回到发现流。 */
  async search(keyword) {
    const src = this._source;
    const kw = String(keyword || "").trim();
    if (!kw) return false;
    if (typeof src.search !== "function") {
      console.warn("[FSM] 当前源不支持搜索:", src.id);
      return false;
    }
    const items = await src.search(kw);
    if (!items || !items.length) {
      this.bus.emit(EVENT.MAIN_QUEUE_REPLACED, { source: src.id, reason: "search", keyword: kw, count: 0 });
      return false;
    }
    this._seed = items;
    this.model.mainRebuild(this._seed);
    this.model.collectionQueue = null;
    this.model.stitchClear();
    this._enteredMainIndex = -1;
    this._collPlayedCount = 0;
    this._tailConsumed = 0;
    this._transition(STATE.MAIN_QUEUE, "search");
    this.bus.emit(EVENT.MAIN_QUEUE_REPLACED, { source: src.id, reason: "search", keyword: kw, count: items.length });
    return true;
  }

  // ============ 宫格点击 / 历史续播 ============
  /** 宫格点击非合集项：跳到主队列第 index 项开始播放（从合集/缝合态切出会先脱离） */
  switchToMainIndex(index) {
    const mq = this.model.mainQueue;
    if (!mq || !Number.isInteger(index) || index < 0 || index >= mq.items.length) return false;
    const st = this.model.state;
    if (st !== STATE.MAIN_QUEUE && st !== STATE.FALLBACK) {
      // 来自合集/缝合态 → 先脱离，回到主队列（替换已永久生效，直接复位指针）
      this.model.collectionQueue = null;
      this.model.stitchClear();
    }
    mq.pointer = index;
    this._enteredMainIndex = index;
    this.model.enteredMainIndex = index;
    this._transition(STATE.MAIN_QUEUE, "switch-index");
    return true;
  }

  /** 从播放记录续播：有合集 → 进入合集并定位到记录所在集、从进度续播；无合集 → 切到主队列项。
   *  跨源续播（记录归属源 ≠ 当前源）先切源，确保合集/元数据/标题按正确源加载解析；
   *  同源或无归属源信息（旧记录）保持当前源。返回 { ok }；失败返回 { ok:false, msg }。 */
  async resumeHistory(rec) {
    if (!rec) return { ok: false, msg: "无播放记录" };
    // 先切到记录归属源：否则下方 listCollection/getVideoMeta 都按「当前源」解析，
    // 跨源续播会加载到错的合集、标题退化成 videoId。
    if (rec.sourceId && rec.sourceId !== this._source?.id) {
      const r = await this.switchSource(rec.sourceId);
      if (r && r.ok === false && !r.stale) return { ok: false, msg: "切换来源失败，无法从该记录续播" };
    }
    if (rec.collectionId) {
      // 记录目标集：优先 episodeIndex，退化按 videoId 在合集内定位（onLoadSuccess 处理）
      this._resumePending = {
        videoId: rec.videoId,
        episodeIndex: rec.episodeIndex != null ? rec.episodeIndex : -1,
        progressSec: rec.progressSec || 0,
        durationSec: rec.durationSec || null,
      };
      // 指针指向该合集在主队列 seed 里的位置（点谁指谁），再进合集——
      // 退出缝合时的替换/进度记在对应推荐项头上；seed 里没有该合集则维持当前指针
      const idx = this.model.mainQueue.seed.findIndex((s) => s && s.collectionId === rec.collectionId);
      if (idx >= 0) this.switchToMainIndex(idx);
      this.enterCollection(rec.collectionId, "history");
      return { ok: true, collectionId: rec.collectionId };
    }
    // 无合集：仅主队列项 → 切到该项并从进度续播
    const idx = this.model.mainQueue.items.findIndex((i) => i.videoId === rec.videoId);
    if (idx < 0) return { ok: false, msg: "该记录已在推荐流之外，无法定位" };
    const it = this.model.mainQueue.items[idx];
    if (rec.progressSec > 3) it.progressSec = rec.progressSec;
    if (rec.durationSec) it.durationSec = rec.durationSec;
    this.switchToMainIndex(idx);
    return { ok: true };
  }
}
