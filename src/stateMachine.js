// stateMachine.js · 调度状态机内核（重构版：缝合态融入合集队列）
//
// 核心变更：
//   - 删除 STATE.STITCH 与所有 stitch* action（5 状态→4 状态）
//   - 合集队列新增 exited 标记：退出合集 = 标记 exited，不销毁队列
//   - 两种入口决定起始位置：autoEnter 从 EP2 开始，手动进入从 EP1（替换）开始
//   - mainItemEnded 优先检查已退出合集的尾巴
//   - swipeNext/swipePrev 从三路分支简化为两路

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
  SWITCH_MAIN_PREV: "SWITCH_MAIN_PREV",
  SWITCH_COLL_NEXT: "SWITCH_COLL_NEXT",
  SWITCH_COLL_PREV: "SWITCH_COLL_PREV",
  SELECT_EPISODE: "SELECT_EPISODE",
};

// 转换表：(state, input) -> action 名
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
    [INPUT.EXIT_COLLECTION]: "collExit",
    [INPUT.SWITCH_COLL_NEXT]: "collSwitchNext",
    [INPUT.SWITCH_COLL_PREV]: "collSwitchPrev",
    [INPUT.SELECT_EPISODE]: "collJumpEpisode",
  },
  [STATE.FALLBACK]: {
    RECOVERED: "fallbackRecovered",
  },
};

export class QueueFSM {
  constructor(bus, source = activeSource()) {
    this.bus = bus;
    this._source = source;
    this._seed = [];
    this.model = new QueueModel([]);
    this.model.state = STATE.MAIN_QUEUE;
    this._enteredMainIndex = -1;
    this._collPlayedCount = 0;
    this._refreshLast = 0;
    this._refreshPending = null;
    this._refreshBoundary = null;
    this._resumePending = null;
    this._entrySource = null;   // 当前进入合集的入口类型
    this.networkLevel = "wifi";
  }

  get state() { return this.model.state; }

  /** 从当前视频源异步拉取主队列并构建模型 */
  async init() {
    this._seed = await this._source.listMainQueue();
    this.model.mainRebuild(this._seed);
    this.bus.emit(EVENT.PROVIDER_READY, { source: this._source.id });
    return this;
  }

  // —— 通用迁移：先更新 state 再广播 ——
  _transition(to, reason) {
    const from = this.model.state;
    this.model.state = to;
    this.bus.emit(EVENT.STATE_CHANGED, { from, to, reason });
    if (from !== to && this._refreshBoundary) {
      const r = this._refreshBoundary; this._refreshBoundary = null;
      this._executeRefresh(r.trigger, r.force);
    }
  }

  // ============ 输入入口 ============
  playbackEnded() { return this._dispatch(INPUT.ITEM_ENDED); }
  exitCollection() { return this._dispatch(INPUT.EXIT_COLLECTION); }
  switchToNextMain() { return this._dispatch(INPUT.SWITCH_MAIN_NEXT); }

  // ============ 滑动输入 ============
  swipeNext() {
    switch (this.model.state) {
      case STATE.MAIN_QUEUE:
        // 有已退出合集 → 沿尾巴前进；尾巴尽则销毁合集
        if (this.model.collectionQueue?.exited) {
          if (this.model.exitedTailLength() > 0) {
            return this._collResumeTail();
          }
          this.model.collectionDestroy();
          return this._dispatch(INPUT.SWITCH_MAIN_NEXT);
        }
        return this._dispatch(INPUT.SWITCH_MAIN_NEXT);
      case STATE.COLLECTION_QUEUE:
        return this._dispatch(INPUT.SWITCH_COLL_NEXT);
      default:
        return false;
    }
  }

  swipePrev() {
    switch (this.model.state) {
      case STATE.MAIN_QUEUE:
        // 有已退出合集 → 尾巴单向，不支持回看
        if (this.model.collectionQueue?.exited) return false;
        return this._dispatch(INPUT.SWITCH_MAIN_PREV);
      case STATE.COLLECTION_QUEUE:
        return this._dispatch(INPUT.SWITCH_COLL_PREV);
      default:
        return false;
    }
  }

  canSwipeNext() {
    return [STATE.MAIN_QUEUE, STATE.COLLECTION_QUEUE].includes(this.model.state);
  }

  canSwipePrev() {
    switch (this.model.state) {
      case STATE.MAIN_QUEUE:
        if (this.model.collectionQueue?.exited) return false;
        return this.model.mainQueue.pointer > 0;
      case STATE.COLLECTION_QUEUE:
        if (this.model.collectionQueue?.exited) return false;
        return !!this.model.collectionQueue && this.model.collectionQueue.pointer > 0;
      default:
        return false;
    }
  }

  /** 进入合集（用户主动点击 / 自动进入 / 历史续播 / 已退出合集重入） */
  enterCollection(collectionId, entrySource = "playAll") {
    const cq = this.model.collectionQueue;
    // 已有已退出合集
    if (cq?.exited) {
      if (cq.collectionId === collectionId) {
        // 重入同一合集 → 恢复 exited 标记
        this.model.collectionUnmarkExited();
        this.bus.emit(EVENT.COLLECTION_ENTERED, {
          collectionId, startEpisodeIndex: cq.pointer, pointerSource: "reenter",
        });
        this._transition(STATE.COLLECTION_QUEUE, "reenter-same");
        return;
      }
      // 不同合集 → 销毁旧的
      this.model.collectionDestroy();
    }
    this._enteredMainIndex = this.model.mainQueue.pointer;
    this.model.enteredMainIndex = this._enteredMainIndex;
    this._collPlayedCount = 0;
    this._entrySource = entrySource;
    this._transition(STATE.LOAD_COLLECTION, "enter-collection");
    this._loadCollection(collectionId, entrySource);
  }

  // 播放进度
  onProgress(currentSec, durationSec, remainingSec, ratio) {
    const st = this.model.state;
    const cq = this.model.collectionQueue;
    let item = null;

    if ((st === STATE.MAIN_QUEUE || st === STATE.FALLBACK) && cq?.exited) {
      // 已退出合集期间，进度写到合集元素（而非主队列元素）
      item = this.model.collectionCurrent();
    } else if (st === STATE.MAIN_QUEUE || st === STATE.FALLBACK) {
      item = this.model.mainCurrent();
    } else if (st === STATE.LOAD_COLLECTION) {
      item = this.model.mainQueue.items[this.model.enteredMainIndex] || null;
    } else if (st === STATE.COLLECTION_QUEUE) {
      item = this.model.collectionCurrent();
    }

    if (item) {
      item.progressSec = currentSec;
      if (durationSec) item.durationSec = durationSec;
    }

    // 已退出合集 + 尾巴懒恢复
    if (cq?.exited && cq.tailLazy) {
      if (remainingSec <= 5 || ratio >= 0.8) {
        this._loadExitedTailLazy();
      }
    }

    // 播放记录：节流广播
    const now = Date.now();
    if (!this._progressEmitAt || now - this._progressEmitAt >= 4000) {
      this._progressEmitAt = now;
      const videoId = this.model.currentVideoId();
      if (videoId) {
        const meta = this._source?.getVideoMeta?.(videoId) || null;
        const collId =
          (cq ? cq.collectionId : null)
          || meta?.collectionId || null;
        this.bus.emit(EVENT.PROGRESS_UPDATE, {
          videoId, sourceId: this._source?.id || null,
          progressSec: currentSec, durationSec: durationSec || null, ratio,
          watched: !!(durationSec && currentSec >= durationSec - 1),
          collectionId: collId,
          episodeIndex: meta?.episodeIndex ?? null,
          title: meta?.title || null,
          poster: meta?.poster || null,
          category: meta?.category || null,
        });
      }
    }
  }

  /** 查询某视频的续播位置 */
  getResumePosition(videoId) {
    if (!videoId) return 0;
    const m = this.model;
    const cq = m.collectionQueue;
    const inCollectionCtx = (m.state === STATE.COLLECTION_QUEUE ||
      (m.state === STATE.MAIN_QUEUE && cq?.exited)) && cq;
    let item = inCollectionCtx ? cq.items.find((i) => i.videoId === videoId) : null;
    if (!item) item = m.mainQueue.items.find((i) => i.videoId === videoId);
    if (!item && cq) item = cq.items.find((i) => i.videoId === videoId);
    let progress = item ? item.progressSec : null;
    let duration = item ? item.durationSec : null;
    // 已退出合集的当前集：进度在合集元素上（inCollectionCtx 分支已覆盖）
    if (!progress || progress <= 3) return 0;
    if (duration && progress >= duration - 1) return 0;
    return progress;
  }

  // ============ 合集加载 ============
  async _loadCollection(collectionId, entrySource, retry = 0) {
    try {
      const { items, startPointer } = await this._source.listCollection(collectionId);
      if (items.length === 0) {
        this._dispatchInternal("LOAD_EMPTY", { collectionId });
      } else {
        this._pendingItems = items.map((i) => i.videoId);
        this._pendingStart = startPointer;
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

  // ============ 内部派发 ============
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
      console.warn(`[FSM] 丢弃表外转换: ${this.model.state} --${input}-->`);
      this.bus.emit(EVENT.FALLBACK_TRIGGERED, { scene: "illegal-transition", reason: `${this.model.state}/${input}`, retryCount: 0 });
      return false;
    }
    const r = this[action]();
    return r === undefined ? true : r;
  }

  // ============ 动作实现 ============

  /** 主队列自然播完：优先检查已退出合集尾巴 → 自动进入合集 → 消费前进 */
  mainItemEnded() {
    const cq = this.model.collectionQueue;
    const cur = this.model.mainCurrent();
    if (cur) { cur.state = "played"; cur.progressSec = 0; }
    const vid = cur ? cur.videoId : null;
    this.bus.emit(EVENT.ITEM_CONSUMED, { videoId: vid, queueType: "main", by: "playout" });

    // ★ 优先：已退出合集有尾巴 → 恢复合集，沿尾巴前进
    if (cq?.exited && this.model.exitedTailLength() > 0) {
      this._collResumeTail();
      return true;
    }
    // 清理无尾巴的已退出合集
    if (cq?.exited) this.model.collectionDestroy();

    // 刷剧：主队列只是发现入口，播完即进合集连播
    const seed = this.model.mainQueue.seed[this.model.mainQueue.pointer];
    const colId = seed?.collectionId;
    if (colId) {
      this.enterCollection(colId, "autoEnter");
      return true;
    }
    // 独立短片：消费前进
    this._advanceMainOrAppend();
    this._transition(STATE.MAIN_QUEUE, "item-ended");
    return true;
  }

  mainSwitchNext() {
    const cur = this.model.mainCurrent();
    if (cur) cur.state = "played";
    const vid = cur ? cur.videoId : null;
    this.bus.emit(EVENT.ITEM_CONSUMED, { videoId: vid, queueType: "main", by: "manual" });
    // 上滑切推荐 → 清除已退出合集（不再关联）
    if (this.model.collectionQueue?.exited) this.model.collectionDestroy();
    this._advanceMainOrAppend();
    this._transition(STATE.MAIN_QUEUE, "switch-next");
    return true;
  }

  /** 下滑：回主队列上一项（不消费） */
  mainSwitchPrev() {
    const mq = this.model.mainQueue;
    if (mq.pointer <= 0) return false;
    mq.pointer--;
    const cur = this.model.mainCurrent();
    if (cur) cur.state = "unplayed";
    this._transition(STATE.MAIN_QUEUE, "switch-prev");
    return true;
  }

  _advanceMainOrAppend() {
    const mq = this.model.mainQueue;
    const next = mq.pointer + 1;
    if (next >= mq.items.length) {
      const oldLen = mq.items.length;
      this._appendFeed();
      mq.pointer = oldLen < mq.items.length ? oldLen : mq.items.length - 1;
    } else {
      mq.pointer = next;
    }
  }

  /** 合集加载成功：根据入口类型决定起始位置 */
  onLoadSuccess({ collectionId, startPointer }) {
    this.model.collectionLoad(this._pendingItems, startPointer || 0, collectionId);
    const cq = this.model.collectionQueue;

    // 历史续播优先
    const resume = this._resumePending;
    this._resumePending = null;

    if (resume) {
      let idx = resume.episodeIndex != null ? resume.episodeIndex : -1;
      if (idx < 0 || idx >= cq.items.length) idx = cq.items.findIndex((i) => i.videoId === resume.videoId);
      if (idx >= 0) {
        cq.pointer = idx;
        cq.items[idx].state = "playing";
        if (resume.progressSec > 3) cq.items[idx].progressSec = resume.progressSec;
        if (resume.durationSec) cq.items[idx].durationSec = resume.durationSec;
      }
    } else if (this._entrySource === "autoEnter") {
      // ★ 规则2A：主队列视频自然播完触发 → 跳过 EP1（已播完），从 EP2 开始
      const mainVid = this.model.mainQueue.items[this._enteredMainIndex]?.videoId;
      if (cq.items.length > 1 && cq.items[0].videoId === mainVid) {
        cq.items[0].state = "played";
        cq.items[0].progressSec = 0;
        cq.pointer = 1;
      }
    } else {
      // ★ 规则2B：用户主动进入 → 定位主队列锚点元素对应的分集，从该集起播。
      //   常规入口锚点=EP1（并入 EP1，行为不变）；但单步退出合集后重入时，锚点槽位已被
      //   替换为退出前正在播的那集 → 按 videoId 定位到对应分集并承担其播放状态，
      //   避免误把当前集并进 EP1（否则切下一集会回到 EP2）。
      const mainItem = this.model.mainQueue.items[this._enteredMainIndex];
      let start = 0;
      if (mainItem && cq.items.length > 0) {
        const i = cq.items.findIndex((it) => it.videoId === mainItem.videoId);
        if (i >= 0) {
          // 锚点在该合集内 → 并入其播放状态到对应分集，从该集起播
          cq.items[i] = { ...mainItem };
          start = i;
        } else {
          // 锚点不在合集内 → 退回并入 EP1（原行为）
          cq.items[0] = { ...mainItem };
        }
      }
      cq.pointer = start;
    }

    const pointerSource = resume ? "history"
      : this._entrySource === "autoEnter" ? "autoEnter"
      : "manual";

    this.bus.emit(EVENT.COLLECTION_ENTERED, {
      collectionId, startEpisodeIndex: cq.pointer, pointerSource,
    });
    this._transition(STATE.COLLECTION_QUEUE, "load-success");
  }

  onLoadRetry({ collectionId, retry }) {
    this.bus.emit(EVENT.FALLBACK_TRIGGERED, { scene: "loadCollection", reason: "timeout", retryCount: retry });
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
    setTimeout(() => {
      this.bus.emit(EVENT.MAIN_QUEUE_REFRESHED, { trigger: "fallback", anchorPreserved: false });
      this._transition(STATE.MAIN_QUEUE, "recovered");
    }, 300);
  }

  /** 合集态当前集播完 */
  collItemEnded() {
    const cq = this.model.collectionQueue;
    const cur = this.model.collectionCurrent();
    if (cur) { cur.state = "played"; cur.progressSec = 0; }
    const vid = cur ? cur.videoId : null;
    this._collPlayedCount++;
    this.bus.emit(EVENT.ITEM_CONSUMED, { videoId: vid, queueType: "collection", by: "playout" });

    if (this.model.collectionIsLast()) {
      this.bus.emit(EVENT.COLLECTION_EXITED, {
        collectionId: cq.collectionId,
        exitType: "autoFinish", playedEpisodes: this._collPlayedCount,
      });
      this.model.collectionDestroy();
      this._transition(STATE.MAIN_QUEUE, "auto-finish");
    } else {
      this.model.collectionAdvance();
      this._transition(STATE.COLLECTION_QUEUE, "item-ended");
    }
    return true;
  }

  /** 上滑：切合集下一集（含已退出合集尾巴处理） */
  collSwitchNext() {
    const cq = this.model.collectionQueue;
    const cur = this.model.collectionCurrent();
    const vid = cur ? cur.videoId : null;

    // 已退出合集 → 沿尾巴前进（在 swipeNext 已路由到此处）
    if (cq?.exited) {
      if (this.model.exitedTailLength() > 0) {
        if (cur) cur.state = "played";
        this.model.exitedTailAdvance();
        this.bus.emit(EVENT.ITEM_CONSUMED, { videoId: vid, queueType: "collection", by: "swipe" });
        this._transition(STATE.COLLECTION_QUEUE, "exited-tail-advanced");
        return true;
      }
      this.model.collectionDestroy();
      this._transition(STATE.MAIN_QUEUE, "exited-tail-finished");
      return true;
    }

    // 正常合集
    if (cur) cur.state = "played";
    this._collPlayedCount++;
    this.bus.emit(EVENT.ITEM_CONSUMED, { videoId: vid, queueType: "collection", by: "swipe" });

    if (this.model.collectionIsLast()) {
      this.bus.emit(EVENT.COLLECTION_EXITED, {
        collectionId: cq.collectionId,
        exitType: "autoFinish", playedEpisodes: this._collPlayedCount,
      });
      this.model.collectionDestroy();
      this._transition(STATE.MAIN_QUEUE, "auto-finish");
      return true;
    }
    this.model.collectionAdvance();
    this._transition(STATE.COLLECTION_QUEUE, "switch-next");
    return true;
  }

  /** 下滑：回合集上一集（不消费） */
  collSwitchPrev() {
    const cq = this.model.collectionQueue;
    if (!cq || cq.pointer <= 0) return false;
    if (cq.exited) return false; // 已退出合集尾巴单向
    cq.pointer--;
    const cur = this.model.collectionCurrent();
    if (cur) cur.state = "unplayed";
    this._collPlayedCount = Math.max(0, this._collPlayedCount - 1);
    this._transition(STATE.COLLECTION_QUEUE, "switch-prev");
    return true;
  }

  /** 单步退出合集：把当前正在播放的合集视频完全并回主队列槽位，销毁合集队列。
   *  主队列指针停在当前正在播放的视频上（槽位元素已被替换为该视频）→ 无缝续播，
   *  无需第二次退出。 */
  collExit() {
    const cq = this.model.collectionQueue;
    if (!cq) return false;

    const played = this._collPlayedCount;
    const idx = this._enteredMainIndex;
    const curItem = cq.items[cq.pointer] || null;

    // 目标视频 = 当前正在播放的合集视频；完全替换主队列槽位并保留播放进度
    if (curItem && idx >= 0) {
      const anchorVideoId = this.model.mainQueue.seed[idx]?.videoId ?? curItem.videoId;
      const replaced = this.model.mainReplacePreserve(idx, curItem);
      // 指针停在当前正在播放的视频上（主队列槽位已替换为同一 videoId）
      this.model.mainQueue.pointer = idx;
      this.model.lastReplacedVideoId = curItem.videoId;
      this.bus.emit(EVENT.MAIN_QUEUE_REPLACED, { anchorVideoId, replacedVideoId: curItem.videoId, ok: replaced });
    }

    this._enteredMainIndex = -1;
    this.model.enteredMainIndex = -1;
    this._collPlayedCount = 0;

    this.bus.emit(EVENT.COLLECTION_EXITED, {
      collectionId: cq.collectionId,
      exitType: "detach",
      playedEpisodes: played,
    });

    this.model.collectionDestroy();
    this._transition(STATE.MAIN_QUEUE, "exit-collection");
    return true;
  }

  /** 手动选集（合集态 / 已退出合集态） */
  collJumpEpisode(index) {
    const cq = this.model.collectionQueue;
    if (!cq || !Number.isInteger(index) || index < 0 || index >= cq.items.length) return false;
    const vid = cq.items[index].videoId;
    const curVid = cq.items[cq.pointer]?.videoId;
    if (vid === curVid) return true;

    // 已退出合集：保存旧当前集进度，更新指针，保持 exited
    if (cq.exited) {
      cq.pointer = index;
      this.bus.emit(EVENT.COLLECTION_ENTERED, {
        collectionId: cq.collectionId, startEpisodeIndex: index, pointerSource: "manualJump",
      });
      this._transition(STATE.MAIN_QUEUE, "exited-jump-episode");
      return true;
    }

    // 正常合集
    cq.pointer = index;
    this.bus.emit(EVENT.COLLECTION_ENTERED, {
      collectionId: cq.collectionId, startEpisodeIndex: index, pointerSource: "manualJump",
    });
    this._transition(STATE.COLLECTION_QUEUE, "jump-episode");
    return true;
  }

  /** 手动选集入口（UI 调用） */
  jumpToEpisode(index) {
    if (this.model.state === STATE.COLLECTION_QUEUE) {
      return this._dispatchInternal(INPUT.SELECT_EPISODE, index);
    }
    // 已退出合集（MAIN_QUEUE 态）
    if (this.model.state === STATE.MAIN_QUEUE && this.model.collectionQueue?.exited) {
      return this.collJumpEpisode(index);
    }
    return false;
  }

  canJumpEpisode() {
    if (this.model.state === STATE.COLLECTION_QUEUE && this.model.collectionQueue) return true;
    if (this.model.state === STATE.MAIN_QUEUE && this.model.collectionQueue?.exited) return true;
    return false;
  }

  // ============ 已退出合集：尾巴恢复 ============

  /** 恢复已退出合集，沿尾巴前进一集 */
  _collResumeTail() {
    const cq = this.model.collectionQueue;
    if (!cq?.exited) return false;
    cq.exited = false;
    cq.pointer++;
    this._collPlayedCount++;
    this.bus.emit(EVENT.COLLECTION_ENTERED, {
      collectionId: cq.collectionId,
      startEpisodeIndex: cq.pointer,
      pointerSource: "tailResume",
    });
    this._transition(STATE.COLLECTION_QUEUE, "resume-tail");
    return true;
  }

  // ============ 已退出合集：懒恢复尾巴 ============

  async _loadExitedTailLazy() {
    const cq = this.model.collectionQueue;
    if (!cq?.exited) return;
    cq.tailLazy = false;
    try {
      const { items } = await this._source.listCollection(cq.collectionId);
      const curIdx = items.findIndex((it) => it.videoId === cq.items[cq.pointer]?.videoId);
      // 保留已有播放状态
      const old = new Map(cq.items.map((i) => [i.videoId, i]));
      if (curIdx >= 0 && curIdx < items.length - 1) {
        const newTail = items.slice(curIdx + 1).map((it) => {
          const prev = old.get(it.videoId);
          return prev || makeItem(it.videoId);
        });
        // 替换 pointer 之后的部分
        cq.items = cq.items.slice(0, cq.pointer + 1).concat(newTail);
      }
    } catch (e) {
      console.warn("[FSM] 已退出合集尾巴重取失败，降级主队列续播");
      this.bus.emit(EVENT.FALLBACK_TRIGGERED, { scene: "recoverTail", reason: e.message, retryCount: 0 });
      this.model.collectionDestroy();
      this._transition(STATE.MAIN_QUEUE, "tail-recover-fail");
    }
  }

  /** 冷启动从快照恢复已退出合集 */
  recoverCollection(snapshot) {
    const idx = this.model.mainQueue.items.findIndex(
      (it) => it.videoId === snapshot.mainAnchorVideoId
    );
    if (idx >= 0) this.model.mainReplace(idx, snapshot.replacedVideoId);

    // 构建 exited 合集队列（尾巴空，tailLazy=true 等懒恢复）
    this.model.collectionQueue = {
      items: [{ videoId: snapshot.currentVideoId, state: "playing", progressSec: snapshot.currentProgressSec || 0, durationSec: null }],
      pointer: 0,
      collectionId: snapshot.collectionId,
      exited: true,
      replacedIndex: idx >= 0 ? idx : 0,
      tailLazy: true,
    };
    this._enteredMainIndex = idx >= 0 ? idx : 0;
    this.model.enteredMainIndex = this._enteredMainIndex;
    if (idx >= 0) this.model.mainQueue.pointer = idx;
    this._collPlayedCount = 0;

    this._transition(STATE.MAIN_QUEUE, "recover");
    this.bus.emit(EVENT.COLLECTION_EXITED, {
      collectionId: snapshot.collectionId,
      exitType: "recovered",
      playedEpisodes: snapshot.currentEpisodeIndex + 1,
      exited: true, recovered: true,
    });
  }

  // ============ 主队列刷新（ADR-11） ============

  requestRefresh(trigger, { force = false } = {}) {
    const now = Date.now();
    if (!force && now - this._refreshLast < CONFIG.refresh.cooldownMs) {
      console.info("[FSM] 主队列刷新冷却中，已丢弃");
      this.bus.emit(EVENT.MAIN_QUEUE_REFRESHED, { trigger, anchorPreserved: false, dropped: true });
      return;
    }
    // 已退出合集 → 挂起（等同原缝合态挂起）
    if (this.model.collectionQueue?.exited) {
      this._refreshPending = { trigger, until: now + CONFIG.refresh.pendingTtlMs };
      console.info("[FSM] 刷新挂起（已退出合集中），脱离后执行");
      this.bus.emit(EVENT.MAIN_QUEUE_REFRESHED, { trigger, anchorPreserved: false, pendingHeld: true });
      return;
    }
    if ([STATE.COLLECTION_QUEUE].includes(this.model.state)) {
      this._refreshBoundary = { trigger, force };
      console.info("[FSM] 刷新推迟至项边界执行");
      return;
    }
    this._executeRefresh(trigger, force);
  }

  _executeRefresh(trigger, force) {
    const anchor = this.model.lastReplacedVideoId;
    this.model.mainRebuild(this._seed);
    const anchorInNew = anchor && this.model.mainQueue.items.some((i) => i.videoId === anchor);
    if (this._refreshPending && this._refreshPending.until < Date.now()) this._refreshPending = null;
    this._refreshPending = null;
    this._refreshLast = Date.now();
    this.bus.emit(EVENT.MAIN_QUEUE_REFRESHED, { trigger, anchorPreserved: !!anchorInNew, force });
    console.info(`[FSM] 主队列整体刷新完成 trigger=${trigger} anchorPreserved=${!!anchorInNew}`);
  }

  _appendFeed() {
    const extra = this._source.appendMainQueue(this.model.mainQueue.items.length);
    if (!extra.length) return;
    const mq = this.model.mainQueue;
    const exist = new Set(mq.items.map((i) => i.videoId));
    let added = 0;
    for (const e of extra) {
      if (!e?.videoId || exist.has(e.videoId)) continue;
      exist.add(e.videoId);
      mq.items.push(makeItem(e.videoId));
      mq.seed.push(e);
      added++;
    }
    if (added) console.info(`[FSM] 主队列追加 ${added} 条（append，非刷新）via source=${this._source.id}`);
  }

  // ============ 视频源切换 ============

  async switchSource(id) {
    if (!registry.use(id)) { console.warn("[FSM] 未知视频源:", id); return { ok: false, failed: false, stale: false, error: "未知视频源" }; }
    const src = registry.active();
    this._switchSeq = (this._switchSeq || 0) + 1;
    const seq = this._switchSeq;
    let seed = [];
    let error = null;
    try {
      seed = await src.listMainQueue();
    } catch (e) {
      error = e;
      console.warn(`[FSM] 切源 ${src.id} 主队列加载失败:`, e.message);
    }
    if (seq !== this._switchSeq) return { ok: false, failed: false, stale: true, error: "stale" };
    this._source = src;
    this._seed = seed;
    this.model.mainRebuild(seed);
    this.model.collectionDestroy();
    this._enteredMainIndex = -1;
    this._collPlayedCount = 0;
    this._refreshPending = null;
    this._refreshBoundary = null;
    this._transition(STATE.MAIN_QUEUE, "source-switch");
    this.bus.emit(EVENT.PROVIDER_READY, {
      source: src.id, switched: true, failed: !!error, error: error?.message || null,
    });
    return { ok: true, failed: !!error, stale: false, error: error?.message || null };
  }

  // ============ 搜索 ============

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
    this.model.collectionDestroy();
    this._enteredMainIndex = -1;
    this._collPlayedCount = 0;
    this._transition(STATE.MAIN_QUEUE, "search");
    this.bus.emit(EVENT.MAIN_QUEUE_REPLACED, { source: src.id, reason: "search", keyword: kw, count: items.length });
    return true;
  }

  // ============ 宫格点击 / 历史续播 ============

  switchToMainIndex(index) {
    const mq = this.model.mainQueue;
    if (!mq || !Number.isInteger(index) || index < 0 || index >= mq.items.length) return false;
    const st = this.model.state;
    if (st !== STATE.MAIN_QUEUE && st !== STATE.FALLBACK) {
      this.model.collectionDestroy();
    }
    mq.pointer = index;
    this._enteredMainIndex = index;
    this.model.enteredMainIndex = index;
    this._transition(STATE.MAIN_QUEUE, "switch-index");
    return true;
  }

  async resumeHistory(rec) {
    if (!rec) return { ok: false, msg: "无播放记录" };
    if (rec.sourceId && rec.sourceId !== this._source?.id) {
      const r = await this.switchSource(rec.sourceId);
      if (r && r.ok === false && !r.stale) return { ok: false, msg: "切换来源失败，无法从该记录续播" };
    }
    if (rec.collectionId) {
      this._resumePending = {
        videoId: rec.videoId,
        episodeIndex: rec.episodeIndex != null ? rec.episodeIndex : -1,
        progressSec: rec.progressSec || 0,
        durationSec: rec.durationSec || null,
      };
      // 清除旧的已退出合集（将进入新的合集）
      if (this.model.collectionQueue?.exited) this.model.collectionDestroy();
      const idx = this.model.mainQueue.seed.findIndex((s) => s && s.collectionId === rec.collectionId);
      if (idx >= 0) this.switchToMainIndex(idx);
      this.enterCollection(rec.collectionId, "history");
      return { ok: true, collectionId: rec.collectionId };
    }
    const idx = this.model.mainQueue.items.findIndex((i) => i.videoId === rec.videoId);
    if (idx < 0) return { ok: false, msg: "该记录已在推荐流之外，无法定位" };
    const it = this.model.mainQueue.items[idx];
    if (rec.progressSec > 3) it.progressSec = rec.progressSec;
    if (rec.durationSec) it.durationSec = rec.durationSec;
    this.switchToMainIndex(idx);
    return { ok: true };
  }

  fallbackRecovered() {
    this._transition(STATE.MAIN_QUEUE, "recovered");
  }
}
