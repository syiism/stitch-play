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
//
// 字段映射语法：
// - 简单字段："title": "name" → 从 raw.name 提取
// - 嵌套字段："title": "user.name" → 从 raw.user.name 提取
// - 数组索引："poster": "covers[0]" → 从 raw.covers[0] 提取
// - 数组过滤："list": "tabs[tab_type=11].data" → 过滤后提取
// - 前缀："videoId": "id|prefix:mf-" → 添加前缀
// - 静态值："category": "_static:短剧" → 固定值
// - 父级引用："title": "_parent.title" → 从父上下文获取
// - 索引值："episodeIndex": "_index" → 当前数组索引
// - 链式转换："title": "name|prepend:第|append:集" → 组合转换

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
    // 特殊字段配置（用于视频解析等复杂场景）
    this._specialFields = cfg.specialFields || {};
    
    // 本地缓存
    this._videoCache = new Map();
    this._collMeta = new Map();
    this._buffer = [];
    this._collListCache = new Map();
    // 沐凡特定：首集映射、分集归属、已看下标
    this._firstEp = new Map();
    this._epBook = new Map();
    this._history = new Map();
    this._seen = new Set();
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
      const json = await resp.json();
      // 处理 API 错误码（沐凡风格）
      if (json.code !== undefined && json.code !== 0) {
        throw new Error(`api-code-${json.code}`);
      }
      return json.data || json;
    } finally {
      clearTimeout(timer);
    }
  }

  // 从响应中提取数据（支持数组过滤语法）
  _extractValue(data, path, context = {}) {
    if (!path) return undefined;
    
    // 特殊标记：静态值
    if (path.startsWith("_static:")) {
      return path.slice(8);
    }
    
    // 特殊标记：父级引用
    if (path.startsWith("_parent.")) {
      const key = path.slice(8);
      return context.parent?.[key];
    }
    
    // 特殊标记：当前索引
    if (path === "_index") {
      return context.index ?? null;
    }
    
    // 处理数组过滤语法：tabs[tab_type=11].data
    const filterMatch = path.match(/^([^\[]+)\[([^\]]+)=([^\]]+)\]\.(.+)$/);
    if (filterMatch) {
      const [, arrayPath, filterKey, filterVal, restPath] = filterMatch;
      const array = this._extractValue(data, arrayPath);
      if (!Array.isArray(array)) return undefined;
      const filtered = array.find(item => String(item[filterKey]) === String(filterVal));
      return filtered ? this._extractValue(filtered, restPath) : undefined;
    }
    
    // 处理数组索引语法：covers[0]
    const indexMatch = path.match(/^(.+)\[(\d+)\]$/);
    if (indexMatch) {
      const [, basePath, idx] = indexMatch;
      const arr = this._extractValue(data, basePath);
      return Array.isArray(arr) ? arr[parseInt(idx)] : undefined;
    }
    
    // 普通路径提取：user.name
    const parts = path.split(".");
    let current = data;
    for (const part of parts) {
      if (current == null) return undefined;
      current = current[part];
    }
    return current;
  }

  // 应用字段转换（前缀、后缀等）
  _applyTransform(value, spec, context = {}) {
    if (spec == null) return undefined;
    
    let strSpec = String(spec);
    let result = value;
    
    // 检查是否有转换管道
    const parts = strSpec.split("|");
    const fieldPath = parts[0];
    const transforms = parts.slice(1);
    
    // 先提取原始值
    if (result === undefined) {
      result = this._extractValue(context.raw, fieldPath, context);
    }
    
    // 应用转换
    for (const transform of transforms) {
      if (transform.startsWith("prefix:")) {
        const prefix = transform.slice(7);
        result = prefix + (result != null ? String(result) : "");
      } else if (transform.startsWith("suffix:")) {
        const suffix = transform.slice(7);
        result = (result != null ? String(result) : "") + suffix;
      } else if (transform.startsWith("prepend:")) {
        const prepend = transform.slice(8);
        result = prepend + (result != null ? String(result) : "");
      } else if (transform.startsWith("append:")) {
        const append = transform.slice(7);
        result = (result != null ? String(result) : "") + append;
      } else if (transform.startsWith("field:")) {
        // 从同一 raw 中提取另一个字段
        const fieldName = transform.slice(6);
        const fieldValue = this._extractValue(context.raw, fieldName, context);
        result = (result != null ? String(result) : "") + (fieldValue != null ? String(fieldValue) : "");
      }
    }
    
    return result;
  }

  // 从响应中提取列表数据
  _extractList(data, listPath, context = {}) {
    if (!listPath) return Array.isArray(data) ? data : [];
    
    // 处理数组过滤语法
    const filterMatch = listPath.match(/^([^\[]+)\[([^\]]+)=([^\]]+)\]\.?(.*)$/);
    if (filterMatch) {
      const [, arrayPath, filterKey, filterVal, restPath] = filterMatch;
      const array = this._extractValue(data, arrayPath);
      if (!Array.isArray(array)) return [];
      const filtered = array.filter(item => String(item[filterKey]) === String(filterVal));
      if (restPath) {
        return filtered.map(item => this._extractValue(item, restPath)).filter(v => v != null);
      }
      return filtered;
    }
    
    return this._extractValue(data, listPath) || [];
  }

  // 映射单个项目
  _mapItem(raw, mapping, endpoint, context = {}) {
    const itemMapping = mapping?.item || {};
    const mapped = {};
    const parentContext = { ...context, raw, parent: context.parent || {} };
    
    for (const [targetKey, sourceSpec] of Object.entries(itemMapping)) {
      const value = this._applyTransform(undefined, sourceSpec, parentContext);
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

  // 代理 URL（沐凡风格）
  _proxify(url) {
    if (!url) return null;
    const m = /^https?:\/\/[^/]+(\/api\/.*)$/.exec(String(url));
    return m ? this._base + m[1] : url;
  }

  // —— 适配器契约方法 ——

  async listMainQueue() {
    const mapping = this._mappings.discover;
    if (!mapping) return [];
    
    try {
      this._seen = new Set();
      const data = await this._get("discover");
      const items = this._extractList(data, mapping.listPath);
      
      const result = [];
      for (let i = 0; i < Math.min(items.length, 10); i++) {
        const raw = items[i];
        const seriesId = this._extractValue(raw, "series_id");
        
        // 去重
        if (!seriesId || this._seen.has(seriesId)) continue;
        this._seen.add(seriesId);
        
        const parentCtx = { title: raw.title, seriesId };
        const item = this._mapItem(raw, mapping, "discover", { parent: parentCtx, index: i });
        
        if (item.collectionId) {
          this._collMeta.set(item.collectionId, {
            collectionId: item.collectionId,
            title: item.title,
            category: item.category
          });
        }
        
        // 存储首集信息（沐凡特定）
        if (seriesId && raw.vid) {
          this._firstEp.set(seriesId, String(raw.vid));
        }
        
        this._videoCache.set(item.videoId, item);
        result.push(item);
      }
      
      // 剩余项放入缓冲
      this._buffer = [];
      for (let i = 10; i < items.length; i++) {
        const raw = items[i];
        const seriesId = this._extractValue(raw, "series_id");
        if (!seriesId || this._seen.has(seriesId)) continue;
        this._seen.add(seriesId);
        const parentCtx = { title: raw.title, seriesId };
        const item = this._mapItem(raw, mapping, "discover", { parent: parentCtx, index: i });
        if (item.videoId) {
          this._buffer.push(item);
          this._videoCache.set(item.videoId, item);
        }
      }
      
      return result;
    } catch (e) {
      console.warn("[Declarative] 发现页加载失败:", e.message);
      return [];
    }
  }

  async listCollection(collectionId) {
    // 命中缓存
    if (this._collListCache.has(collectionId)) {
      const cached = this._collListCache.get(collectionId);
      if (cached instanceof Promise) return cached;
      return cached;
    }
    
    const mapping = this._mappings.collection;
    if (!mapping) {
      return { collectionId, title: collectionId, items: [], startPointer: 0 };
    }
    
    const seriesId = collectionId.replace(/^mf-col-/, "");
    const meta = this._collMeta.get(collectionId);
    const parentCtx = { title: meta?.title || collectionId, seriesId };
    
    const fetchPromise = (async () => {
      try {
        const data = await this._get("collection", { seriesId });
        const items = this._extractList(data, mapping.listPath);
        
        const metaTitle = mapping.meta?.titlePath 
          ? this._extractValue(data, mapping.meta.titlePath, { parent: parentCtx })
          : parentCtx.title;
        
        if (!this._collMeta.has(collectionId)) {
          this._collMeta.set(collectionId, { collectionId, title: metaTitle });
        }
        
        const resultItems = items.map((raw, index) => {
          const itemId = this._extractValue(raw, "item_id");
          if (itemId) {
            this._epBook.set(itemId, seriesId);
          }
          
          const item = this._mapItem(raw, mapping, "collection", { 
            parent: { ...parentCtx, title: metaTitle }, 
            index 
          });
          item.collectionId = collectionId;
          if (item.episodeIndex === null || item.episodeIndex === undefined) {
            item.episodeIndex = index;
          }
          this._videoCache.set(item.videoId, item);
          return item;
        });
        
        const result = {
          collectionId,
          title: metaTitle,
          items: resultItems,
          startPointer: this._history.get(seriesId) ?? 0
        };
        
        this._collListCache.set(collectionId, result);
        return result;
      } catch (e) {
        console.warn("[Declarative] 合集加载失败:", collectionId, e.message);
        this._collListCache.delete(collectionId);
        return { collectionId, title: collectionId, items: [], startPointer: 0 };
      }
    })();
    
    this._collListCache.set(collectionId, fetchPromise);
    return fetchPromise;
  }

  appendMainQueue(count = 4) {
    // 缓冲见底前预取
    if (this._buffer.length <= count) {
      this._prefetchDiscover();
    }
    return this._buffer.splice(0, count);
  }

  /** 后台补一批发现页卡片进缓冲 */
  _prefetchDiscover() {
    if (this._fetchingFeed) return;
    this._fetchingFeed = true;
    
    (async () => {
      try {
        const mapping = this._mappings.discover;
        if (!mapping) return;
        
        const data = await this._get("discover");
        const items = this._extractList(data, mapping.listPath);
        
        for (const raw of items) {
          const seriesId = this._extractValue(raw, "series_id");
          if (!seriesId || this._seen.has(seriesId)) continue;
          this._seen.add(seriesId);
          const parentCtx = { title: raw.title, seriesId };
          const item = this._mapItem(raw, mapping, "discover", { parent: parentCtx });
          if (item.videoId) {
            this._buffer.push(item);
            this._videoCache.set(item.videoId, item);
          }
        }
      } catch (e) {
        console.warn("[Declarative] 预取失败:", e.message);
      } finally {
        this._fetchingFeed = false;
      }
    })();
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
      return items.map(raw => {
        const seriesId = this._extractValue(raw, this._specialFields?.search?.seriesId || "series_id");
        const parentCtx = { title: raw.title, seriesId };
        return this._mapItem(raw, mapping, "search", { parent: parentCtx });
      });
    } catch (e) {
      console.warn("[Declarative] 搜索失败:", e.message);
      return [];
    }
  }

  async resolveSrc(videoId) {
    const mapping = this._mappings.video;
    if (!mapping) return null;
    
    try {
      let itemId, bookId;
      
      // 解析 videoId 获取 itemId 和 bookId
      if (videoId.startsWith("mf-ep-")) {
        itemId = videoId.slice(6);
        bookId = this._epBook.get(itemId);
        if (!bookId) return null;
      } else if (videoId.startsWith("mf-drama-")) {
        const seriesId = videoId.slice(9);
        itemId = this._firstEp.get(seriesId);
        if (!itemId) {
          // 拉目录取第一集
          const collData = await this.listCollection(`mf-col-${seriesId}`);
          if (collData.items.length > 0) {
            const firstItem = collData.items[0];
            itemId = firstItem.videoId.replace(/^mf-ep-/, "");
            this._firstEp.set(seriesId, itemId);
            this._epBook.set(itemId, seriesId);
          } else {
            return null;
          }
        }
        bookId = seriesId;
      } else {
        // 通用模式
        const meta = this._videoCache.get(videoId);
        if (meta?.collectionId && meta.episodeIndex !== null) {
          // 从合集获取
          const collData = await this.listCollection(meta.collectionId);
          if (collData.items[meta.episodeIndex]) {
            const epRaw = collData.items[meta.episodeIndex];
            // 需要重新获取视频地址
          }
        }
        // 简化处理：假设 videoId 可直接用于请求
        itemId = videoId;
        bookId = null;
      }
      
      const params = {};
      if (itemId) params.itemId = itemId;
      if (bookId) params.bookId = bookId;
      
      const data = await this._get("video", params);
      
      // 提取 URL
      let url = this._extractValue(data, mapping.urlPath);
      if (!url) {
        url = data.url || data.play_url || data.src || data.video_url;
      }
      
      // 代理 URL
      url = this._proxify(url);
      
      if (!url) return null;
      
      // 更新缓存
      const meta = this._videoCache.get(videoId);
      if (meta && url) {
        meta.src = url;
        if (data.pic && !meta.poster) meta.poster = data.pic;
        if (typeof data.duration === "number" && data.duration > 0) meta.duration = data.duration;
      }
      
      return url;
    } catch (e) {
      console.warn("[Declarative] 视频解析失败:", videoId, e.message);
      return null;
    }
  }
}
