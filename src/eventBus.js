// eventBus.js · 封闭事件目录 QueueEvent 总线（重构版：缝合态融入合集队列）
//
// 变更：删除 STITCH_ENTERED / STITCH_TAIL_ADVANCED / STITCH_EXITED（13→10）
// 缝合态语义统一由 COLLECTION_EXITED / COLLECTION_ENTERED 的 exitType / pointerSource 区分。

// —— 封闭事件目录 ——
export const EVENT = {
  STATE_CHANGED:       "StateChanged",        // from, to, reason
  ITEM_CONSUMED:       "ItemConsumed",        // videoId, queueType, by
  COLLECTION_ENTERED:  "CollectionEntered",   // collectionId, startEpisodeIndex, pointerSource
  COLLECTION_EXITED:   "CollectionExited",    // collectionId, exitType, playedEpisodes
  MAIN_QUEUE_REPLACED: "MainQueueReplaced",   // anchorVideoId, replacedVideoId
  MAIN_QUEUE_REFRESHED:"MainQueueRefreshed",  // trigger, anchorPreserved
  FALLBACK_TRIGGERED:  "FallbackTriggered",   // scene, reason, retryCount
  PRELOAD_STAGE:       "PreloadStageChanged", // videoId, level, result
  PROVIDER_READY:      "ProviderReady",       // source, switched?
  PROGRESS_UPDATE:     "ProgressUpdate",      // videoId, progressSec, durationSec, ratio, watched?
};

// 目录白名单（运行时校验，防止非法事件混入）
const ALLOWED = new Set(Object.values(EVENT));

export class QueueEventBus {
  constructor() {
    this._listeners = new Map(); // type -> Set<fn>
  }

  /** 订阅（只读消费者） */
  on(type, fn) {
    if (!ALLOWED.has(type)) {
      throw new Error(`[EventBus] 非法事件类型（目录封闭）: ${type}`);
    }
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this._listeners.get(type)?.delete(fn);
  }

  /** 发布输出事件（仅状态机内核调用） */
  emit(type, payload = {}) {
    if (!ALLOWED.has(type)) {
      throw new Error(`[EventBus] 拒绝广播未注册事件: ${type}`);
    }
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); }
      catch (e) { console.error(`[EventBus] 订阅者异常 @${type}:`, e); }
    }
  }
}
