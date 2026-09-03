// declarativeSource.js · 声明式视频源适配器（通用模板）
//
// 目标：让「简单 REST API 视频源」无需编写 JavaScript 代码，仅通过 config.json 声明式配置即可接入。
// 适用场景：API 返回 JSON、字段结构清晰、无需复杂认证/签名逻辑的视频源。
//
// 配置结构（在 config.json 的 sources 数组中）：
// {
//   "id": "my-source",
//   "label": "我的视频源",
//   "mode": "declarative",
//   "proxy": "ms",                          // 可选，代理前缀（需在 proxies 中定义）
//   "config": {
//     "endpoints": {
//       "discover": "/api/discover",        // 发现页接口
//       "search": "/api/search",            // 搜索接口（可选）
//       "directory": "/api/directory",      // 合集目录接口
//       "video": "/api/video"               // 取流接口（可选，用于懒解析）
//     },
//     "params": {                           // 各接口的固定参数（可选）
//       "discover": { "type": "recommend" },
//       "search": { "limit": 20 }
//     },
//     "mapping": {                          // 字段映射（将 API 返回字段映射到 QueueItem）
//       "videoId": "video_id",              // API 返回的 video_id → QueueItem.videoId
//       "title": "video_title",             // API 返回的 video_title → QueueItem.title
//       "src": "play_url",                  // API 返回的 play_url → QueueItem.src
//       "poster": "cover_image",            // API 返回的 cover_image → QueueItem.poster
//       "duration": "duration_sec",         // API 返回的 duration_sec → QueueItem.duration
//       "collectionId": "series_id",        // API 返回的 series_id → QueueItem.collectionId
//       "episodeIndex": "episode_order",    // API 返回的 episode_order → QueueItem.episodeIndex
//       "category": "category_name"         // API 返回的 category_name → QueueItem.category
//     },
//     "collectionMapping": {                // 合集字段的特殊映射（可选，用于 directory 接口）
//       "items": "episodes",                // API 返回的 episodes 数组 → 合集元素列表
//       "title": "series_title"             // API 返回的 series_title → 合集标题
//     },
//     "transform": {                        // 转换管道（可选，对原始数据进行预处理）
//       "videoId": "prefix:my-",            // 给 videoId 添加前缀
//       "title": "trim",                    // 去除标题首尾空格
//       "duration": "number"                // 确保 duration 是数字
//     },
//     "listPath": "data.items",             // 发现页/搜索结果的数据路径（支持点号嵌套，可选）
//     "searchListPath": "data.results",     // 搜索结果的数据路径（可选，缺省同 listPath）
//     "collectionItemsPath": "data.episodes" // 合集目录的数据路径（可选）
//   }
// }

import { normalize } from "./schema.js";
import { CONFIG } from "../config.js";

// 内置默认端点（当配置未指定时使用）
const DEFAULT_ENDPOINTS = {
  discover: "/api/discover",
  search: "/api/search",
  directory: "/api/directory",
  video: "/api/video",
};

// 内置默认字段映射（尝试常见字段名）
const DEFAULT_MAPPING = {
  videoId: ["video_id", "vid", "id", "videoId"],
  title: ["title", "name", "video_title", "displayName"],
  src: ["src", "url", "play_url", "playUrl", "video_url"],
  poster: ["poster", "cover", "cover_image", "thumbnail"],
  duration: ["duration", "duration_sec", "dur", "durationSec"],
  collectionId: ["collection_id", "series_id", "playlist_id", "collectionId"],
  episodeIndex: ["episode_index", "episode_order", "ep", "index", "episodeIndex"],
  category: ["category", "kind", "type", "category_name"],
};

// 转换函数注册表
const TRANSFORMERS = {
  trim: (v) => (typeof v === "string" ? v.trim() : v),
  number: (v) => (typeof v === "number" ? v : Number(v)),
  string: (v) => String(v),
  lower: (v) => (typeof v === "string" ? v.toLowerCase() : v),
  upper: (v) => (typeof v === "string" ? v.toUpperCase() : v),
};

// 解析数据路径（如 "data.items" → obj.data.items）
function getByPath(obj, path) {
  if (!path || !obj) return obj;
  const keys = String(path).split(".");
  let cur = obj;
  for (const k of keys) {
    if (cur == null || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

// 应用转换管道
function applyTransform(value, transform) {
  if (!transform) return value;
  if (typeof transform === "string") {
    // 简单字符串：查找内置转换器
    const fn = TRANSFORMERS[transform];
    return fn ? fn(value) : value;
  }
  if (Array.isArray(transform)) {
    // 数组：依次应用多个转换
    return transform.reduce((acc, t) => applyTransform(acc, t), value);
  }
  if (typeof transform === "object" && transform.prefix) {
    // 前缀：{ prefix: "xxx" }
    return String(transform.prefix) + String(value ?? "");
  }
  if (typeof transform === "object" && transform.suffix) {
    // 后缀：{ suffix: "xxx" }
    return String(value ?? "") + String(transform.suffix);
  }
  return value;
}

// 从多种候选字段名中获取值
function pickFromCandidates(raw, candidates) {
  if (!Array.isArray(candidates)) candidates = [candidates];
  for (const key of candidates) {
    if (raw[key] !== undefined) return raw[key];
  }
  return undefined;
}

export class DeclarativeSource {
  constructor(opts = {}) {
    this.id = opts.id || "declarative-source";
    this.label = opts.label || "声明式视频源";
    
    // 保存完整配置以便访问自定义字段（如 _category_short）
    this._config = opts.config || {};
    
    // baseUrl：浏览器侧为同源代理前缀（opts.baseUrl），Node 测试直连传上游地址
    this._base = String(opts.baseUrl || "").replace(/\/+$/, "");
    this._defaultBase = String(opts.defaultBase || this._base).replace(/\/+$/, "");
    
    // 端点配置
    const userEndpoints = this._config.endpoints || {};
    this._endpoints = { ...DEFAULT_ENDPOINTS, ...userEndpoints };
    
    // 固定参数
    this._params = this._config.params || {};
    
    // 字段映射（统一为数组形式，便于 pickFromCandidates 处理）
    const userMapping = this._config.mapping || {};
    this._mapping = {};
    for (const [key, val] of Object.entries(DEFAULT_MAPPING)) {
      this._mapping[key] = Array.isArray(val) ? val : [val];
    }
    for (const [key, val] of Object.entries(userMapping)) {
      // 忽略以 _ 开头的特殊配置字段
      if (!key.startsWith("_")) {
        this._mapping[key] = Array.isArray(val) ? val : [val];
      }
    }
    
    // 合集字段映射
    this._collMapping = this._config.collectionMapping || {
      items: ["items", "episodes", "videos", "data"],
      title: ["title", "name", "series_title"],
    };
    
    // 转换管道
    this._transform = this._config.transform || {};
    
    // 数据路径
    this._listPath = this._config.listPath || "data";
    this._searchListPath = this._config.searchListPath || this._listPath;
    this._collItemsPath = this._config.collectionItemsPath || null;
    
    // 超时设置
    this._timeout = opts.timeoutMs || 45000;
    
    // 缓存
    this._videoCache = new Map();
    this._collMeta = new Map();
    this._collListCache = new Map();
  }

  // —— 基础请求 ——
  get baseUrl() { return this._base; }
  
  setBase(url) {
    const u = String(url || "").trim().replace(/\/+$/, "");
    if (!u) { this._base = this._defaultBase; return true; }
    if (u === this._base) return false;
    this._base = u; return true;
  }
  
  resetBase() { this._base = this._defaultBase; }
  
  get defaultBase() { return this._defaultBase; }

  _url(path, params) {
    const q = params ? "?" + new URLSearchParams(params).toString() : "";
    return `${this._base}${path}${q}`;
  }
  
  async _get(path, params) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this._timeout);
    try {
      const resp = await fetch(this._url(path, params), { signal: ctrl.signal });
      if (!resp.ok) throw new Error(`http-${resp.status}`);
      const json = await resp.json();
      // 不检查 code，因为不同 API 响应结构不同
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  _put(item) { 
    this._videoCache.set(item.videoId, item); 
    return item; 
  }

  _proxify(url) {
    if (!url) return null;
    const m = /^https?:\/\/[^/]+(\/api\/.*)$/.exec(String(url));
    return m ? this._base + m[1] : url;
  }

  // —— 字段映射与转换 ——
  _mapField(raw, fieldKey) {
    const candidates = this._mapping[fieldKey];
    const value = pickFromCandidates(raw, candidates);
    if (value === undefined) return undefined;
    return applyTransform(value, this._transform[fieldKey]);
  }

  _buildQueueItem(raw, collectionId = null, episodeIndex = null, extraContext = {}) {
    // 支持强制覆盖 videoId（用于合集分集）
    let videoId = raw._forceVideoId || this._mapField(raw, "videoId");
    
    // 特殊处理：如果配置了 category 是自定义值（如 _category_short），则读取该值
    const categoryConfig = this._config?.mapping?.category;
    let category = null;
    if (categoryConfig && categoryConfig.startsWith("_")) {
      category = this._config[categoryConfig] || null;
    } else {
      category = this._mapField(raw, "category");
    }
    
    // 如果没有映射到 videoId，尝试常见字段
    if (!videoId) {
      videoId = raw.series_id ?? raw.vid ?? raw.id ?? raw.video_id ?? null;
    }
    
    if (!videoId) return null;
    
    // 应用 transform 中的前缀/后缀（仅当没有_forceVideoId 时）
    if (!raw._forceVideoId) {
      const videoIdTransform = this._transform?.videoId;
      if (videoIdTransform) {
        if (Array.isArray(videoIdTransform)) {
          for (const t of videoIdTransform) {
            videoId = applyTransform(String(videoId), t);
          }
        } else {
          videoId = applyTransform(String(videoId), videoIdTransform);
        }
      }
    }
    
    // 处理 collectionId
    let mappedCollectionId = this._mapField(raw, "collectionId");
    if (!mappedCollectionId && raw.series_id) {
      const collTransform = this._transform?.collectionId;
      if (collTransform) {
        if (Array.isArray(collTransform)) {
          mappedCollectionId = String(raw.series_id);
          for (const t of collTransform) {
            mappedCollectionId = applyTransform(mappedCollectionId, t);
          }
        } else {
          mappedCollectionId = applyTransform(String(raw.series_id), collTransform);
        }
      }
    }
    
    const shaped = {
      videoId:      String(videoId),
      title:        String(this._mapField(raw, "title") ?? raw.title ?? raw.name ?? "未命名"),
      src:          String(this._mapField(raw, "src") ?? raw.src ?? raw.url ?? raw.play_url ?? ""),
      poster:       this._mapField(raw, "poster") ?? raw.poster ?? raw.cover ?? null,
      duration:     this._mapField(raw, "duration") ?? raw.duration ?? raw.dur ?? null,
      collectionId: mappedCollectionId ?? collectionId,
      episodeIndex: this._mapField(raw, "episodeIndex") ?? raw.episode_index ?? raw.ep ?? episodeIndex,
      category:     category,
    };
    
    // 如果 collectionId 存在但还没有合集元数据，尝试构建
    if (shaped.collectionId && !this._collMeta.has(shaped.collectionId)) {
      const collTitle = this._mapField(raw, "title") ?? raw.title ?? shaped.collectionId;
      this._collMeta.set(shaped.collectionId, {
        collectionId: shaped.collectionId,
        title: collTitle,
        category: shaped.category,
        raw: raw,
      });
    }
    
    // 保存首集信息（用于沐凡源的懒解析）
    if (raw.vid && shaped.collectionId) {
      const sid = String(raw.series_id ?? "").replace(/^mf-col-/, "");
      if (sid) {
        if (!this._firstEp) this._firstEp = new Map();
        this._firstEp.set(sid, String(raw.vid));
      }
    }
    
    return this._put(normalize(shaped, null, this.id));
  }

  // —— 主队列：发现页 ——
  async listMainQueue() {
    try {
      const data = await this._get(this._endpoints.discover, this._params.discover || {});
      const list = getByPath(data, this._listPath);
      if (!Array.isArray(list)) {
        console.warn("[DeclarativeSource] 发现页返回非数组:", list);
        return [];
      }
      
      const items = [];
      for (const raw of list) {
        const item = this._buildQueueItem(raw);
        if (item && item.videoId) {
          items.push(item);
        }
      }
      
      if (items.length === 0) {
        throw new Error("发现页加载失败：请检查 config.json 中的 endpoints 和 listPath 配置");
      }
      
      return items;
    } catch (e) {
      console.warn("[DeclarativeSource] 发现页加载失败:", e.message);
      throw e;
    }
  }

  // —— 合集：剧集目录 ——
  async listCollection(collectionId) {
    if (this._collListCache.has(collectionId)) {
      return this._collListCache.get(collectionId);
    }
    
    const p = this._fetchCollection(collectionId)
      .then((r) => {
        if (r.items.length > 0) {
          this._collListCache.set(collectionId, r);
        } else {
          this._collListCache.delete(collectionId);
        }
        return r;
      })
      .catch((e) => {
        this._collListCache.delete(collectionId);
        throw e;
      });
    
    this._collListCache.set(collectionId, p);
    return p;
  }

  async _fetchCollection(collectionId) {
    try {
      // 提取 book_id（去掉 mf-col- 前缀）
      const bookId = String(collectionId).replace(/^mf-col-/, "");
      
      const data = await this._get(this._endpoints.directory, {
        ...(this._params.directory || {}),
        book_id: bookId,
        collection_id: collectionId,
        series_id: bookId,
      });
      
      // 获取合集元数据
      const meta = this._collMeta.get(collectionId) || { title: collectionId };
      
      // 获取合集项目列表
      let itemsRaw = getByPath(data, this._collItemsPath) || 
                     data.item_data_list ||
                     data.episodes || 
                     data.videos || 
                     data.items ||
                     [];
      
      if (!Array.isArray(itemsRaw)) {
        console.warn("[DeclarativeSource] 合集返回非数组:", itemsRaw);
        itemsRaw = [];
      }
      
      const items = itemsRaw.map((raw, i) => {
        const itemId = String(raw.item_id ?? raw.id ?? "");
        // 缓存 item_id → book_id 映射（用于懒解析）
        if (itemId && bookId) {
          if (!this._epBook) this._epBook = new Map();
          this._epBook.set(itemId, bookId);
        }
        
        // 构建分集 videoId：mf-ep-{item_id}
        const epVideoId = itemId ? `mf-ep-${itemId}` : null;
        
        return this._buildQueueItem({
          ...raw,
          // 强制覆盖 videoId 为分集格式
          _forceVideoId: epVideoId,
        }, collectionId, i);
      }).filter(Boolean);
      
      return {
        collectionId,
        title: meta.title,
        items,
        startPointer: 0,
      };
    } catch (e) {
      console.warn("[DeclarativeSource] 合集加载失败:", collectionId, e.message);
      throw e;
    }
  }

  // —— 翻到底续拉（声明式源暂不支持，返回空数组）——
  appendMainQueue() {
    return [];
  }

  // —— 搜索 ——
  async search(keyword) {
    const kw = String(keyword || "").trim();
    if (!kw) return [];
    
    if (!this._endpoints.search) {
      console.warn("[DeclarativeSource] 未配置搜索端点");
      return [];
    }
    
    try {
      const data = await this._get(this._endpoints.search, {
        ...(this._params.search || {}),
        keyword: kw,
        key: kw,
        q: kw,
        query: kw,
      });
      
      const list = getByPath(data, this._searchListPath);
      if (!Array.isArray(list)) {
        console.warn("[DeclarativeSource] 搜索返回非数组:", list);
        return [];
      }
      
      const seen = new Set();
      const out = [];
      for (const raw of list) {
        const vid = this._mapField(raw, "videoId");
        if (!vid || seen.has(vid)) continue;
        seen.add(vid);
        const item = this._buildQueueItem(raw);
        if (item && item.videoId) {
          out.push(item);
        }
      }
      return out;
    } catch (e) {
      console.warn("[DeclarativeSource] 搜索失败:", e.message);
      return [];
    }
  }

  // —— 懒解析可播放地址 ——
  async resolveSrc(videoId) {
    if (!this._endpoints.video) {
      const meta = this._videoCache.get(videoId);
      return meta?.src || null;
    }
    
    try {
      const meta = this._videoCache.get(videoId);
      
      // 沐凡源特殊处理：从 videoId 提取 book_id 和 item_id
      let params = {
        ...(this._params.video || {}),
      };
      
      if (videoId.startsWith("mf-ep-")) {
        // mf-ep-{item_id} → 需要 book_id
        const itemId = videoId.slice(6);
        params.item_id = itemId;
        // 尝试从缓存获取 book_id
        if (this._epBook) {
          const bookId = this._epBook.get(itemId);
          if (bookId) params.book_id = bookId;
        }
      } else if (videoId.startsWith("mf-drama-")) {
        // mf-drama-{series_id} → 需要先获取首集
        const seriesId = videoId.slice(9);
        if (this._firstEp && this._firstEp.has(seriesId)) {
          const itemId = this._firstEp.get(seriesId);
          params.item_id = itemId;
          params.book_id = seriesId;
        } else {
          // 尝试拉取目录获取首集
          try {
            const collData = await this._get(this._endpoints.directory, { book_id: seriesId });
            const list = collData.item_data_list || [];
            if (list.length > 0) {
              const firstItem = String(list[0].item_id);
              params.item_id = firstItem;
              params.book_id = seriesId;
              // 缓存首集信息
              if (!this._firstEp) this._firstEp = new Map();
              if (!this._epBook) this._epBook = new Map();
              this._firstEp.set(seriesId, firstItem);
              this._epBook.set(firstItem, seriesId);
            }
          } catch (e) {
            console.warn("[DeclarativeSource] 获取首集失败:", e.message);
          }
        }
      } else {
        // 通用处理
        params.video_id = videoId;
        params.vid = videoId;
        params.id = videoId;
      }
      
      const data = await this._get(this._endpoints.video, params);
      
      const url = this._proxify(
        this._mapField(data, "src") || 
        data.url || 
        data.play_url || 
        data.video_url || 
        null
      );
      
      if (url && meta) {
        meta.src = url;
      }
      
      return url;
    } catch (e) {
      console.warn("[DeclarativeSource] resolveSrc 失败:", videoId, e.message);
      return null;
    }
  }

  // —— 同步读 ——
  getVideoMeta(videoId) { 
    return this._videoCache.get(videoId) || null; 
  }
  
  getCollectionMeta(collectionId) {
    return this._collMeta.get(collectionId) || { collectionId, title: collectionId };
  }
}
