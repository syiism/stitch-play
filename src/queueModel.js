// queueModel.js · 队列逻辑层数据结构（v1.0 §六 + v1.1 §7.2）
//
// 仅作为「数据容器 + 只读取值辅助」，所有状态迁移与副作用由 stateMachine 内核裁决。
// 这样保证 v1.0 §4.2 转换表是代码里唯一真相源。

export const STATE = {
  MAIN_QUEUE:        "MainQueue",
  LOAD_COLLECTION:   "LoadCollection",
  COLLECTION_QUEUE:  "CollectionQueue",
  STITCH:            "Stitch",
  FALLBACK:          "Fallback",
};

export function makeItem(videoId, state = "unplayed") {
  // v1.0 §六：state: PlaybackState（未播/播放中/已播完/进度等）——
  // progressSec/durationSec 是元素自身的播放状态，回看（下滑/选集）时据此续播
  return { videoId, state, progressSec: 0, durationSec: null };
}

export class QueueModel {
  constructor(seed) {
    // 主队列：items 为推荐流卡片，pointer 指向「当前正在播放的元素」下标。
    // 语义更正：指针不再是在队列中预支的下一消费位，而是当前元素（正在播放/正在看的角色）。
    this.mainQueue = {
      items: seed.map((s) => makeItem(s.videoId)),
      pointer: 0,          // 初始播放第 0 项（指针=当前元素）
      seed,                // 保留种子，用于整体刷新重置
    };
    // 合集队列：单一槽位，进入时清空重灌
    this.collectionQueue = null; // { items, pointer, collectionId }
    // 缝合态：显式缝合标记（不可仅靠队列内容推导）
    this.stitch = {
      active: false,
      currentVideoId: null,
      remainingTail: [],   // 当前集之后的合集部分（可懒加载）
      replacedIndex: -1,   // 主队列中被替换的位置
      collectionId: null,
      tailLazy: false,     // 尾巴是否尚未从接口重取（懒恢复）
      progressSec: 0,      // 缝合态当前集的播放进度（v1.0 §五：回来继续从当前进度播放）
    };
    this.lastReplacedVideoId = null; // 最近一次替换落到的 videoId（刷新锚点保留校验用）
    this.enteredMainIndex = -1;      // 进入合集时正在看的主队列槽位（加载期间继续显示它）
  }

  // —— 主队列 ——
  mainCurrent() { return this.mainQueue.items[this.mainQueue.pointer] || null; }
  mainCurrentVideoId() { const it = this.mainCurrent(); return it ? it.videoId : null; }
  mainAdvance() { if (this.mainQueue.pointer < this.mainQueue.items.length - 1) this.mainQueue.pointer++; }
  mainReplace(index, videoId) {
    if (index >= 0 && index < this.mainQueue.items.length) {
      this.mainQueue.items[index] = makeItem(videoId, "played");
      this.lastReplacedVideoId = videoId;
      return true;
    }
    return false;
  }
  mainRebuild(seed) {
    this.mainQueue.items = seed.map((s) => makeItem(s.videoId));
    this.mainQueue.pointer = 0;
    this.mainQueue.seed = seed;
  }

  // —— 合集队列 ——
  /** 进入合集：构建合集元素。主队列里同 videoId 的元素（如正在播的推荐位即本合集 EP1）
   *  的播放状态并入合集元素——画面本来就无缝（同视频不重载），进度记录也必须连续，
   *  否则跳走再跳回只能续播「进入合集后」的进度，两份记录就此分叉（v1.0 §六）。 */
  collectionLoad(items, pointer, collectionId) {
    const carry = new Map(this.mainQueue.items.map((i) => [i.videoId, i]));
    this.collectionQueue = {
      items: items.map((id) => {
        const src = carry.get(id);
        if (src && (src.progressSec > 0 || src.state === "played")) {
          return {
            videoId: id,
            state: src.state === "played" ? "played" : "playing",
            progressSec: src.progressSec || 0,
            durationSec: src.durationSec ?? null,
          };
        }
        return makeItem(id);
      }),
      pointer, collectionId,
    };
  }
  collectionCurrent() { return this.collectionQueue ? this.collectionQueue.items[this.collectionQueue.pointer] : null; }
  collectionCurrentVideoId() { const it = this.collectionCurrent(); return it ? it.videoId : null; }
  collectionIsLast() {
    return this.collectionQueue ? this.collectionQueue.pointer >= this.collectionQueue.items.length - 1 : false;
  }
  collectionAdvance() { if (this.collectionQueue) this.collectionQueue.pointer++; }

  // —— 缝合态 ——
  stitchEnter(currentVideoId, remainingTail, replacedIndex, collectionId, tailLazy = false, progressSec = 0) {
    this.stitch = { active: true, currentVideoId, remainingTail, replacedIndex, collectionId, tailLazy, progressSec };
  }
  stitchTailAdvance() {
    if (this.stitch.remainingTail.length === 0) return null;
    const next = this.stitch.remainingTail.shift();
    this.stitch.currentVideoId = next.videoId;
    this.stitch.progressSec = next.progressSec || 0; // 新当前集沿用其已记录进度
    return next;
  }
  stitchTailLength() { return this.stitch.remainingTail.length; }
  stitchClear() {
    this.stitch = { active: false, currentVideoId: null, remainingTail: [], replacedIndex: -1, collectionId: null, tailLazy: false, progressSec: 0 };
  }

  /** 当前应播放的视频 id（按状态返回） */
  currentVideoId() {
    switch (this.state) {
      case STATE.MAIN_QUEUE:
      case STATE.FALLBACK:
        return this.mainCurrentVideoId();
      case STATE.LOAD_COLLECTION:
        // 加载期间继续显示「进入合集前正在看的主项」，不跳到预支指针
        return this.enteredMainIndex >= 0
          ? (this.mainQueue.items[this.enteredMainIndex]?.videoId ?? this.mainCurrentVideoId())
          : this.mainCurrentVideoId();
      case STATE.COLLECTION_QUEUE:
        return this.collectionCurrentVideoId();
      case STATE.STITCH:
        return this.stitch.currentVideoId;
      default:
        return this.mainCurrentVideoId();
    }
  }
}
