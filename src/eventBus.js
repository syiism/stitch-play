// eventBus.js · 封闭事件目录 QueueEvent 总线（ADR-10）
//
// 设计要点（v1.1 §4）：
//  1) 目录封闭：仅下列 EVENT 可上总线，禁止运行时动态注册
//  2) 载荷只述事实：广播「发生了什么」，不夹带「请去做什么」
//  3) 订阅者只读：UI / 预加载 / 埋点 / 持久化 均只消费，不改写队列状态
//
// 数据流：输入事件 → 状态机裁决 → 输出事件(QueueEvent) → 总线 → 订阅者

// —— 封闭事件目录（对应 v1.1 §4.3）——
export const EVENT = {
  STATE_CHANGED:       "StateChanged",        // from, to, reason
  ITEM_CONSUMED:       "ItemConsumed",        // videoId, queueType, by
  COLLECTION_ENTERED:  "CollectionEntered",   // collectionId, startEpisodeIndex, pointerSource
  COLLECTION_EXITED:   "CollectionExited",    // collectionId, exitType, playedEpisodes
  STITCH_ENTERED:      "StitchEntered",       // collectionId, episodeIndex, tailLength
  STITCH_TAIL_ADVANCED:"StitchTailAdvanced",  // episodeIndex
  STITCH_EXITED:       "StitchExited",        // exitType, tailConsumed
  MAIN_QUEUE_REPLACED: "MainQueueReplaced",   // anchorVideoId, replacedVideoId
  MAIN_QUEUE_REFRESHED:"MainQueueRefreshed",  // trigger, anchorPreserved
  FALLBACK_TRIGGERED:  "FallbackTriggered",   // scene, reason, retryCount
  PRELOAD_STAGE:       "PreloadStageChanged", // videoId, level, result
  PROVIDER_READY:      "ProviderReady",       // source, switched?（视频源就绪/切换完成）
  PROGRESS_UPDATE:     "ProgressUpdate",      // videoId, progressSec, durationSec, ratio, watched?（供播放记录/持久化）
};

// 目录白名单（用于运行时校验，防止非法事件混入）
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
    return () => this._listeners.get(type)?.delete(fn); // 返回取消订阅
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
