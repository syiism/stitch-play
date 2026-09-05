// stateMachine.js · 调度状态机内核（重构版：缝合态融入合集队列）
//
// 退出语义（现行）：
//   - collExit 单步退出：当前集替换主队列槽位（保留进度）→ 回主队列；
//     合集标记 exited 滞留内存（不销毁、不参与路由），等下一次进入合集时整体替换
//   - 主队列语义不受滞留合集影响：进度/续播/滑动/刷新恒走主队列；
//     当前集播完 → 自动进入当前推荐位所属合集（锚点归一匹配取下一集）
//   - tailConsumed 事件 = 滞留合集被替换/清理（快照随之清除）

import { STATE, QueueModel, makeItem } from "./queueModel.js";
import { EVENT } from "./eventBus.js";
import { CONFIG } from "./config.js";
import { registry, activeSource, episodeDisplayTitle } from "./sources/index.js";

// 输入事件（内部，进状态机；不上总线）。导出仅供调试器/文档读取内核契约，勿在内核外派发。
export const INPUT = {
  ITEM_ENDED: "ITEM_ENDED",
  ENTER_COLLECTION: "ENTER_COLLECTION",
  EXIT_COLLECTION: "EXIT_COLLECTION",
  SWITCH_MAIN_NEXT: "SWITCH_MAIN_NEXT",
  SWITCH_MAIN_PREV: "SWITCH_MAIN_PREV",
  SWITCH_COLL_NEXT: "SWITCH_COLL_NEXT",
  SWITCH_COLL_PREV: "SWITCH_COLL_PREV",
  SELECT_EPISODE: "SELECT_EPISODE",
};

// 转换表：(state, input) -> action 名（唯一真相源；导出仅供调试器/文档读取，勿在内核外改写）
export const TABLE = {
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
        // 退出合集 = 已回主队列：滞留的已退出合集不参与路由，等下一次进合集时整体替换
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
        return this.model.mainQueue.pointer > 0;
      case STATE.COLLECTION_QUEUE:
        return !!this.model.collectionQueue && this.model.collectionQueue.pointer > 0;
      default:
        return false;
    }
  }

  /** 进入合集（用户主动点击 / 自动进入 / 历史续播） */
  enterCollection(collectionId, entrySource = "playAll") {
    // 滞留的已退出合集（无论同异）在此整体替换：退出合集 = 回主队列，旧合集不再续播
    if (this.model.collectionQueue?.exited) this._discardExitedCollection();
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
    let item = null;

    if (st === STATE.MAIN_QUEUE || st === STATE.FALLBACK) {
      // 退出合集 = 回主队列：进度恒写主队列元素（滞留合集不参与）
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

    // 播放记录：节流广播
    const now = Date.now();
    if (!this._progressEmitAt || now - this._progressEmitAt >= 4000) {
      this._progressEmitAt = now;
      const videoId = this.model.currentVideoId();
      if (videoId) {
        const meta = this._source?.getVideoMeta?.(videoId) || null;
        const cq = this.model.collectionQueue;
        const collId =
          (st === STATE.COLLECTION_QUEUE && cq ? cq.collectionId : null)
          || meta?.collectionId || null;
        this.bus.emit(EVENT.PROGRESS_UPDATE, {
          videoId, sourceId: this._source?.id || null,
          progressSec: currentSec, durationSec: durationSec || null, ratio,
          watched: !!(durationSec && currentSec >= durationSec - 1),
          collectionId: collId,
          episodeIndex: meta?.episodeIndex ?? null,
          // 历史记录标题：分集用「剧名 + 第N集」，普通元素用其自身标题
          title: episodeDisplayTitle(this._source, meta) || meta?.title || null,
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
    // 合集态优先合集元素；其余（含退出合集后的主队列元素）先查主队列
    let item = null;
    if (m.state === STATE.COLLECTION_QUEUE) item = cq.items.find((i) => i.videoId === videoId);
    if (!item) item = m.mainQueue.items.find((i) => i.videoId === videoId);
    if (!item && cq) item = cq.items.find((i) => i.videoId === videoId);
    let progress = item ? item.progressSec : null;
    let duration = item ? item.durationSec : null;
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

  /** videoId 等值比较：剥掉分集前缀（ep-）后比对——源可能以裸 item id（如沐凡 card.vid）
   *  与 ep-<item_id> 两种形态指代同一分集，直接 === 会漏配锚点 */
  _sameVideoId(a, b) {
    const norm = (v) => String(v ?? "").replace(/^ep-/, "");
    return norm(a) === norm(b);
  }

  /** 主队列自然播完：按主队列语义自动进合集（发现入口）→ 消费前进。
   *  滞留的已退出合集在此被新合集整体替换（enterCollection 统一处理）。 */
  mainItemEnded() {
    const cur = this.model.mainCurrent();
    if (cur) { cur.state = "played"; cur.progressSec = 0; }
    const vid = cur ? cur.videoId : null;
    this.bus.emit(EVENT.ITEM_CONSUMED, { videoId: vid, queueType: "main", by: "playout" });

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
      // 追加失败且队列原本为空时也不能落 -1（指针非法会让 current 恒 null）
      mq.pointer = oldLen < mq.items.length ? oldLen : Math.max(0, mq.items.length - 1);
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
        // 历史续播时，将保存的剧名写回分集元素（修复退出合集后显示"第 1 集"而非原剧名的问题）
        if (resume.title) {
          cq.items[idx].title = resume.title;
        }
      }
    } else if (this._entrySource === "autoEnter") {
      // ★ 规则2A：主队列视频自然播完触发 → 从已播完那集的下一集续播。
      //   主队列卡 id（沐凡=card.vid 裸 item_id / 其他源=drama-{series_id}）与分集 id（ep-{item_id}）
      //   形态不同，按 _sameVideoId 归一比对：命中集标记已播完取下一集；
      //   未命中则视为 EP1 已播完，从 EP2 起播（自动 +1）。
      const mainVid = this.model.mainQueue.items[this._enteredMainIndex]?.videoId;
      const hit = mainVid ? cq.items.findIndex((it) => this._sameVideoId(it.videoId, mainVid)) : -1;
      if (hit >= 0 && cq.items.length > 1) {
        // 锚点就是合集内某一集 → 标记已播完，从其下一集续播
        cq.items[hit].state = "played";
        cq.items[hit].progressSec = 0;
        cq.pointer = Math.min(hit + 1, cq.items.length - 1);
      } else if (cq.items.length > 1) {
        // 锚点不在合集内（id 体系不同）→ 视为 EP1 播完，从 EP2 起播
        cq.items[0].state = "played";
        cq.items[0].progressSec = 0;
        cq.pointer = 1;
      }
    } else {
      // ★ 规则2B：用户主动进入 → 定位主队列锚点元素对应的分集，从该集起播。
      //   常规入口锚点=EP1；单步退出合集后重入时，锚点槽位已被替换为退出前正在播的那集
      //   → 按 videoId（归一比对）定位到对应分集并并入其播放状态，避免误把当前集并进 EP1。
      //   注意：锚点元素只含播放态（videoId/state/progress），无分集标题/集号——
      //   命中时必须保留分集自身身份，只并入进度/状态，绝不能整只覆写。
      const mainItem = this.model.mainQueue.items[this._enteredMainIndex];
      let start = 0;
      if (mainItem && cq.items.length > 0) {
        const i = cq.items.findIndex((it) => this._sameVideoId(it.videoId, mainItem.videoId));
        if (i >= 0) {
          // 锚点就是合集内某一集 → 分集保留身份，并入锚点的播放进度/状态，从该集起播
          cq.items[i] = {
            ...cq.items[i],
            state: mainItem.state || cq.items[i].state,
            progressSec: mainItem.progressSec || 0,
            durationSec: mainItem.durationSec ?? cq.items[i].durationSec,
          };
          start = i;
        } else {
          // 锚点不在合集内（id 体系不同）→ 保留 EP1 分集身份与“第1集”标题，
          // 仅将锚点的播放进度/状态并入 EP1 以承接续播
          cq.items[0].state = mainItem.state || cq.items[0].state;
          cq.items[0].progressSec = mainItem.progressSec || 0;
          cq.items[0].durationSec = mainItem.durationSec ?? cq.items[0].durationSec;
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

  /** 上滑：切合集下一集 */
  collSwitchNext() {
    const cq = this.model.collectionQueue;
    const cur = this.model.collectionCurrent();
    const vid = cur ? cur.videoId : null;

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
    cq.pointer--;
    const cur = this.model.collectionCurrent();
    if (cur) cur.state = "unplayed";
    this._collPlayedCount = Math.max(0, this._collPlayedCount - 1);
    this._transition(STATE.COLLECTION_QUEUE, "switch-prev");
    return true;
  }

  /** 单步退出合集：把当前正在播放的合集视频完全并回主队列槽位并保留进度，合集标记
   *  exited（不销毁，尾巴保留）。主队列指针停在当前正在播放的视频上（槽位元素已被
   *  替换为该视频）→ 播放无缝续播，无需二次退出；播完/上滑由 exited 尾巴路由接管。 */
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

    // 标记 exited 而非销毁：尾巴保留（快照订阅者据此持久化退出锚点）
    this.model.collectionMarkExited(Math.max(idx, 0));
    this._transition(STATE.MAIN_QUEUE, "exit-collection");
    return true;
  }

  /** 销毁已退出合集（尾巴耗尽 / 用户切走）→ 广播 tailConsumed，快照订阅者据此清理锚点 */
  _discardExitedCollection() {
    const cq = this.model.collectionQueue;
    if (!cq?.exited) return false;
    this.bus.emit(EVENT.COLLECTION_EXITED, {
      collectionId: cq.collectionId,
      exitType: "tailConsumed",
      playedEpisodes: this._collPlayedCount,
    });
    this.model.collectionDestroy();
    return true;
  }

  /** 手动选集（合集态） */
  collJumpEpisode(index) {
    const cq = this.model.collectionQueue;
    if (!cq || !Number.isInteger(index) || index < 0 || index >= cq.items.length) return false;
    const vid = cq.items[index].videoId;
    const curVid = cq.items[cq.pointer]?.videoId;
    if (vid === curVid) return true;

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
    return false;
  }

  canJumpEpisode() {
    return this.model.state === STATE.COLLECTION_QUEUE && !!this.model.collectionQueue;
  }

  // ============ 已退出合集：滞留与替换 ============
  // 退出合集（collExit）后合集标记 exited 滞留内存：不销毁、不参与任何路由，
  // 等下一次进入合集时由 enterCollection 整体替换（tailConsumed）。

  /** 冷启动从快照恢复已退出合集 */
  recoverCollection(snapshot) {
    const idx = this.model.mainQueue.items.findIndex(
      (it) => it.videoId === snapshot.mainAnchorVideoId
    );
    if (idx >= 0) {
      // 进度落到主队列元素：退出后主队列即播放上下文，快照进度从这里续播
      this.model.mainReplacePreserve(idx, {
        videoId: snapshot.replacedVideoId,
        state: "playing",
        progressSec: snapshot.currentProgressSec || 0,
        durationSec: null,
      });
      this.model.mainQueue.pointer = idx;
    }

    // 构建 exited 滞留合集（惰性存在，等下一次进合集替换）
    this.model.collectionQueue = {
      items: [{ videoId: snapshot.currentVideoId, state: "playing", progressSec: snapshot.currentProgressSec || 0, durationSec: null }],
      pointer: 0,
      collectionId: snapshot.collectionId,
      exited: true,
      replacedIndex: idx >= 0 ? idx : 0,
      tailLazy: false,
    };
    this._enteredMainIndex = idx >= 0 ? idx : 0;
    this.model.enteredMainIndex = this._enteredMainIndex;
    this._collPlayedCount = 0;
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
    // 已退出合集滞留不拦刷新：退出即回主队列，刷新照常执行
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
    // 切源 = 丢弃一切合集上下文（含已退出合集，快照锚点随 tailConsumed 清理）
    this._discardExitedCollection();
    this.model.collectionDestroy();
    this._enteredMainIndex = -1;
    this._collPlayedCount = 0;
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
    // 源实现的搜索异常不外抛（否则 UI 侧成为未处理的 Promise rejection），按空结果降级
    let items = [];
    try {
      items = await src.search(kw);
    } catch (e) {
      console.warn("[FSM] 搜索失败:", src.id, e.message);
    }
    if (!items || !items.length) {
      this.bus.emit(EVENT.MAIN_QUEUE_REPLACED, { source: src.id, reason: "search", keyword: kw, count: 0 });
      return false;
    }
    this._seed = items;
    this.model.mainRebuild(this._seed);
    this._discardExitedCollection();
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
      this._discardExitedCollection();
      this.model.collectionDestroy();
    } else if (this.model.collectionQueue?.exited && index !== this.model.collectionQueue.replacedIndex) {
      // 主队列宫格点击到已退出合集槽位之外 → 视为脱离尾巴（tailConsumed 让快照清理）
      this._discardExitedCollection();
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
        title: rec.title || null,  // 继承原剧名
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
