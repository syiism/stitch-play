// adapter.js · 视频源适配器接口（契约）+ 注册表
//
// 适配器契约（内核只调用以下方法，返回结构必须是规范 QueueItem / 含它的结构）：
//   id: string
//   label: string
//   async listMainQueue(): QueueItem[]                                // 主队列推荐流（每项带 collectionId 标记）
//   async listCollection(collectionId): { collectionId, title, items: QueueItem[], startPointer }
//   appendMainQueue(count): QueueItem[]                               // 翻到底续拉（演示同步返回；真实源可改为缓存分页）
//   getVideoMeta(videoId): QueueItem | null                           // 已拉取则同步返回（供渲染 / 播放）
//   getCollectionMeta(collectionId): { collectionId, title } | null   // 合集标题（供 UI）
//
// 可选扩展方法（内核 feature-detect，源未实现则跳过对应功能）：
//   async search(keyword): QueueItem[] | null    // 按「本源的语义」搜索并归一化为 QueueItem；
//                                                // 返回空数组 = 无结果；源不支持可返回 null 或直接不实现
//   async resolveSrc(videoId): string | null     // 懒解析可播放地址（player 起播时调用）
//
// 兼容性保证：内核绝不直接 import 任何具体源；统一通过 registry.active() 取当前源。
// 因此「添加 / 切换视频源」只动 sources/ 目录，不动调度内核。

export class SourceRegistry {
  constructor() {
    this._map = new Map();
    this._active = null;
  }
  /** 注册一个适配器（首个注册者默认激活） */
  register(adapter) {
    this._map.set(adapter.id, adapter);
    if (!this._active) this._active = adapter.id;
    return this;
  }
  /** 切换激活源，成功返回 true */
  use(id) {
    if (!this._map.has(id)) return false;
    this._active = id;
    return true;
  }
  active() { return this._map.get(this._active) || null; }
  get(id) { return this._map.get(id) || null; }
  list() { return [...this._map.values()].map((a) => ({ id: a.id, label: a.label })); }
}

// 全局单例注册表（整个应用共享同一份「当前激活源」）
export const registry = new SourceRegistry();

export function activeSource() { return registry.active(); }
export function listSources() { return registry.list(); }
