// declarativeSource.js · 声明式视频源：零代码配置 REST API 数据源
//
// 使用方式：在 config.json 的 sources 中添加 mode: "declarative" 的配置项，
// 内核自动实例化 DeclarativeSource 适配器，无需编写任何 JS 代码。
//
// 配置示例：
// {
//   "id": "my-rest-source",
//   "label": "我的 REST 视频源",
//   "mode": "declarative",
//   "proxy": "myapi",
//   "config": {
//     "endpoints": {
//       "discover": "/api/recommend",
//       "collection": "/api/series/{seriesId}/episodes",
//       "search": "/api/search?q={keyword}",
//       "video": "/api/video/{videoId}/play"
//     },
//     "mappings": {
//       "discover": {
//         "listPath": "data.items",
//         "item": {
//           "videoId": "series_id",
//           "title": "title",
//           "poster": "cover_url",
//           "collectionId": "series_id",
//           "category": "type"
//         }
//       },
//       "collection": {
//         "listPath": "episodes",
//         "meta": { "titlePath": "series_title" },
//         "item": {
//           "videoId": "episode_id",
//           "title": "episode_title",
//           "episodeIndex": "index",
//           "collectionId": "series_id"
//         }
//       },
//       "search": {
//         "listPath": "results",
//         "item": { /* 同 discover.item */ }
//       },
//       "video": {
//         "urlPath": "play_url"
//       }
//     },
//     "params": {
//       "discover": { "page_size": 20 },
//       "collection": {}
//     },
//     "categoryMap": { "drama": "短剧", "anime": "漫剧" }
//   }
// }

import { normalize } from "./schema.js";

export class DeclarativeSource {
  constructor(opts = {}) {
    const cfg = opts.config || {};
    
    this.id = opts.id || "declarative-source";
    this.label = opts.label || "声明式数据源";
    this._base = String(opts.baseUrl || "/").replace(/\/+$/, "");
    this._defaultBase = this._base;
    
    // 端点配置
    this._endpoints = cfg.endpoints || {};
    // 字段映射配置
    this._mappings = cfg.mappings || {};
    // 固定参数配置
    this._params = cfg.params || {};
    // 分类映射
    this._categoryMap = cfg.categoryMap || {};
    
    // 本地缓存
    this._videoCache = new Map();
    this._collMeta = new Map();
    this._buffer = [];
  }

  get baseUrl() { return this._base; }
  
  setBase(url) {
    const u = String(url || "").trim().replace(/\/+$/, "");
    if (!u) { this._base = this._defaultBase; return true; }
    if (u === this._base) return false;
    this._base = u;
    return true;
  }
  
  resetBase() { this._base = this._defaultBase; }
  get defaultBase() { return this._defaultBase; }

  // 构建请求 URL
  _url(endpoint, params = {}) {
    let path = this._endpoints[endpoint] || "";
    
    // 替换路径参数 {xxx}
    for (const [key, value] of Object.entries(params)) {
      path = path.replace(`{${key}}`, encodeURIComponent(value));
    }
    
    // 合并固定参数
    const fixedParams = this._params[endpoint] || {};
    const allParams = { ...fixedParams };
    
    // 只添加未在路径中使用的参数作为查询参数
    for (const [key, value] of Object.entries(params)) {
      if (!this._endpoints[endpoint].includes(`{${key}}`)) {
        allParams[key] = value;
      }
    }
    
    const q = Object.keys(allParams).length ? "?" + new URLSearchParams(allParams).toString() : "";
    return `${this._base}${path}${q}`;
  }

  async _get(endpoint, params = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    
    try {
      const resp = await fetch(this._url(endpoint, params), { signal: ctrl.signal });
      if (!resp.ok) throw new Error(`http-${resp.status}`);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // 从响应中提取列表数据
  _extractList(data, listPath) {
    if (!listPath) return Array.isArray(data) ? data : [];
    return listPath.split(".").reduce((obj, key) => obj?.[key], data) || [];
  }

  // 映射单个项目
  _mapItem(raw, mapping, endpoint) {
    const itemMapping = mapping?.item || {};
    const mapped = {};
    
    for (const [targetKey, sourceKey] of Object.entries(itemMapping)) {
      const value = sourceKey.split(".").reduce((obj, key) => obj?.[key], raw);
      if (value !== undefined) {
        mapped[targetKey] = value;
      }
    }
    
    // 分类映射
    if (mapped.category && this._categoryMap[mapped.category]) {
      mapped.category = this._categoryMap[mapped.category];
    }
    
    return normalize(mapped, {}, this.id);
  }

  // —— 适配器契约方法 ——

  async listMainQueue() {
    const mapping = this._mappings.discover;
    if (!mapping) return [];
    
    try {
      const data = await this._get("discover");
      const items = this._extractList(data, mapping.listPath);
      const result = items.slice(0, 10).map(raw => {
        const item = this._mapItem(raw, mapping, "discover");
        if (item.collectionId) {
          this._collMeta.set(item.collectionId, {
            collectionId: item.collectionId,
            title: item.title,
            category: item.category
          });
        }
        this._videoCache.set(item.videoId, item);
        return item;
      });
      
      // 剩余项放入缓冲
      this._buffer = items.slice(10).map(raw => this._mapItem(raw, mapping, "discover"));
      
      return result;
    } catch (e) {
      console.warn("[Declarative] 发现页加载失败:", e.message);
      return [];
    }
  }

  async listCollection(collectionId) {
    const mapping = this._mappings.collection;
    if (!mapping) return { collectionId, title: collectionId, items: [], startPointer: 0 };
    
    try {
      const data = await this._get("collection", { seriesId: collectionId.replace(/^decl-/, "") });
      const items = this._extractList(data, mapping.listPath);
      
      const metaTitle = mapping.meta?.titlePath 
        ? mapping.meta.titlePath.split(".").reduce((obj, key) => obj?.[key], data) 
        : collectionId;
      
      if (!this._collMeta.has(collectionId)) {
        this._collMeta.set(collectionId, {
          collectionId,
          title: metaTitle
        });
      }
      
      const resultItems = items.map((raw, index) => {
        const item = this._mapItem(raw, mapping, "collection");
        item.collectionId = collectionId;
        if (item.episodeIndex === null || item.episodeIndex === undefined) {
          item.episodeIndex = index;
        }
        this._videoCache.set(item.videoId, item);
        return item;
      });
      
      return {
        collectionId,
        title: metaTitle,
        items: resultItems,
        startPointer: 0
      };
    } catch (e) {
      console.warn("[Declarative] 合集加载失败:", collectionId, e.message);
      return { collectionId, title: collectionId, items: [], startPointer: 0 };
    }
  }

  appendMainQueue(count = 4) {
    return this._buffer.splice(0, count);
  }

  getVideoMeta(videoId) {
    return this._videoCache.get(videoId) || null;
  }

  getCollectionMeta(collectionId) {
    return this._collMeta.get(collectionId) || { collectionId, title: collectionId };
  }

  async search(keyword) {
    const mapping = this._mappings.search;
    if (!mapping) return [];
    
    try {
      const data = await this._get("search", { keyword });
      const items = this._extractList(data, mapping.listPath);
      return items.map(raw => this._mapItem(raw, mapping, "search"));
    } catch (e) {
      console.warn("[Declarative] 搜索失败:", e.message);
      return [];
    }
  }

  async resolveSrc(videoId) {
    const mapping = this._mappings.video;
    if (!mapping) return null;
    
    try {
      const data = await this._get("video", { videoId });
      const url = mapping.urlPath 
        ? mapping.urlPath.split(".").reduce((obj, key) => obj?.[key], data) 
        : data.url || data.play_url || data.src;
      
      // 更新缓存
      const meta = this._videoCache.get(videoId);
      if (meta && url) {
        meta.src = url;
      }
      
      return url || null;
    } catch (e) {
      console.warn("[Declarative] 视频解析失败:", videoId, e.message);
      return null;
    }
  }
}
