// queueModel.js · 队列逻辑层数据结构（重构版：缝合态融入合集队列）
//
// 核心变更：删除 STATE.STITCH 与独立 stitch 对象；
// 合集队列新增 exited / replacedIndex / tailLazy 字段，退出合集时标记而非销毁。
// 仅作为「数据容器 + 只读取值辅助」，所有状态迁移与副作用由 stateMachine 内核裁决。

export const STATE = {
  MAIN_QUEUE:        "MainQueue",
  LOAD_COLLECTION:   "LoadCollection",
  COLLECTION_QUEUE:  "CollectionQueue",
  FALLBACK:          "Fallback",
};

export function makeItem(videoId, state = "unplayed") {
  return { videoId, state, progressSec: 0, durationSec: null };
}

export class QueueModel {
  constructor(seed) {
    this.mainQueue = {
      items: seed.map((s) => makeItem(s.videoId)),
      pointer: 0,
      seed,
    };
    this.collectionQueue = null;
    this.lastReplacedVideoId = null;
    this.enteredMainIndex = -1;
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
  /** 完全替换主队列元素并保留播放进度（单步退出合集：把当前正在播放的合集视频并回主队列槽位）。
   *  与 mainReplace 的区别：保留 progressSec / durationSec / state，供后续续播与选集。 */
  mainReplacePreserve(index, item) {
    if (index < 0 || index >= this.mainQueue.items.length) return false;
    if (!item) return false;
    this.mainQueue.items[index] = {
      videoId: item.videoId,
      state: item.state || "played",
      progressSec: item.progressSec || 0,
      durationSec: item.durationSec ?? null,
    };
    this.lastReplacedVideoId = item.videoId;
    return true;
  }
  mainRebuild(seed) {
    this.mainQueue.items = seed.map((s) => makeItem(s.videoId));
    this.mainQueue.pointer = 0;
    this.mainQueue.seed = seed;
  }

  // —— 合集队列 ——
  /** 进入合集：构建合集元素。主队列里同 videoId 的元素播放状态并入合集元素。 */
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
      exited: false,
      replacedIndex: -1,
      tailLazy: false,
    };
  }
  collectionCurrent() { return this.collectionQueue ? this.collectionQueue.items[this.collectionQueue.pointer] : null; }
  collectionCurrentVideoId() { const it = this.collectionCurrent(); return it ? it.videoId : null; }
  collectionIsLast() {
    return this.collectionQueue ? this.collectionQueue.pointer >= this.collectionQueue.items.length - 1 : false;
  }
  collectionAdvance() { if (this.collectionQueue) this.collectionQueue.pointer++; }

  // —— 已退出合集的尾巴操作（替代原 stitch* 方法）——

  /** 退出合集：标记 exited + 记录替换槽位，不销毁队列 */
  collectionMarkExited(replacedIndex) {
    if (!this.collectionQueue) return;
    this.collectionQueue.exited = true;
    this.collectionQueue.replacedIndex = replacedIndex;
  }

  /** 恢复已退出合集（取消 exited 标记） */
  collectionUnmarkExited() {
    if (!this.collectionQueue) return;
    this.collectionQueue.exited = false;
  }

  /** 已退出合集的尾巴长度 */
  exitedTailLength() {
    const cq = this.collectionQueue;
    if (!cq || !cq.exited) return 0;
    return cq.items.length - cq.pointer - 1;
  }

  /** 已退出合集沿尾巴前进一集 */
  exitedTailAdvance() {
    const cq = this.collectionQueue;
    if (!cq || !cq.exited || cq.pointer >= cq.items.length - 1) return null;
    cq.pointer++;
    return cq.items[cq.pointer];
  }

  /** 销毁合集队列 */
  collectionDestroy() { this.collectionQueue = null; }

  /** 当前应播放的视频 id（按状态 + exited 标记返回） */
  currentVideoId() {
    switch (this.state) {
      case STATE.MAIN_QUEUE:
      case STATE.FALLBACK: {
        // 有已退出合集 → 播的是退出时那集（主队列槽位已被替换为同一 videoId）
        const cq = this.collectionQueue;
        if (cq?.exited) return cq.items[cq.pointer]?.videoId ?? this.mainCurrentVideoId();
        return this.mainCurrentVideoId();
      }
      case STATE.LOAD_COLLECTION:
        return this.enteredMainIndex >= 0
          ? (this.mainQueue.items[this.enteredMainIndex]?.videoId ?? this.mainCurrentVideoId())
          : this.mainCurrentVideoId();
      case STATE.COLLECTION_QUEUE:
        return this.collectionCurrentVideoId();
      default:
        return this.mainCurrentVideoId();
    }
  }
}
