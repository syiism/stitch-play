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
    // 需透传给 server 的自定义 http 上游（proxy=true + 自定义 http 地址时由 index.js 传入）
    this._proxyUpstream = opts.proxyUpstream || null;
    
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
    this._firstEp = new Map();          // series_id → 首集 item_id
    this._epBook = new Map();           // item_id → book_id
    this._seen = new Set();             // 本轮发现页去重
    this._feedBuffer = [];              // 发现页续拉缓冲
    this._fetchingFeed = false;         // 后台预取进行中标记

    // 发现页分批规模（可经 config.feedEach / config.appendBatch 覆盖）
    this._feedEach = Number(this._config.feedEach) > 0 ? Number(this._config.feedEach) : 20;
    this._appendBatch = Number(this._config.appendBatch) > 0 ? Number(this._config.appendBatch) : 20;
  }

  // —— 基础请求 ——
  get baseUrl() { return this._base; }
  
  setBase(url) {
    const u = String(url || "").trim().replace(/\/+$/, "");
    if (!u) { this._base = this._defaultBase; return true; }
    if (u === this._base) return false;
    this._base = u; return true;
  }
  
  setProxyUpstream(u) { this._proxyUpstream = u || null; }
  
  resetBase() { this._base = this._defaultBase; }
  
  get defaultBase() { return this._defaultBase; }

  _url(path, params) {
    const q = new URLSearchParams(params || {});
    if (this._proxyUpstream) q.set("proxy_upstream", this._proxyUpstream); // 明文查询参数透传上游
    const qs = q.toString();
    return `${this._base}${path}${qs ? "?" + qs : ""}`;
  }
  
  async _get(path, params) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this._timeout);
    try {
      const resp = await fetch(this._url(path, params), { signal: ctrl.signal });
      if (!resp.ok) throw new Error(`http-${resp.status}`);
      const json = await resp.json();
      // 与 mufanAdapter 一致：剥掉 {code,msg,data} 信封，取内层 data。
      // 各 listPath/collectionItemsPath/取流 URL 均按「内层数据」编写；
      // 无 data 字段（非信封结构，如列表直接返回 / 平铺对象）则原样返回，保持通用性。
      if (json && typeof json === "object" && !Array.isArray(json) && json.data !== undefined) {
        return json.data;
      }
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
    // 支持强制覆盖 videoId（用于合集分集）。
    // 注意：this._mapField 命中映射时内部已应用 transform，切勿重复应用（否则前缀翻倍，
    // 复现场景：videoId 呈现 "mf-drama-mf-drama-…"）。故用 alreadyFmt 标记是否已格式化。
    let videoId, alreadyFmt = true;
    if (!raw._forceVideoId) {
      videoId = this._mapField(raw, "videoId");
      if (!videoId) {
        // 未命中映射 → 尝试常见字段兜底
        videoId = raw.series_id ?? raw.vid ?? raw.id ?? raw.video_id ?? null;
        alreadyFmt = false; // 兜底字段尚未应用 transform
      }
    } else {
      videoId = raw._forceVideoId;
    }
    
    // 特殊处理：如果配置了 category 是自定义值（如 _category_short），则读取该值
    const categoryConfig = this._config?.mapping?.category;
    let category = null;
    if (categoryConfig && categoryConfig.startsWith("_")) {
      category = this._config[categoryConfig] || null;
    } else {
      category = this._mapField(raw, "category");
    }
    
    if (!videoId) return null;
    
    // 仅「兜底字段」未被格式化时才补应用 transform 前缀/后缀（_mapField 命中时已应用）
    if (!alreadyFmt) {
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
      episodeIndex: episodeIndex != null
        ? episodeIndex
        : (this._mapField(raw, "episodeIndex") ?? raw.episode_index ?? raw.ep ?? null),
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
    // 每次拉取都是一次全新发现页请求（上游会重排），去重只在本轮内生效；
    // 否则切走再切回时所有剧都“已见过”，主队列会错误地变空
    this._seen = new Set();
    try {
      const data = await this._get(this._endpoints.discover, this._params.discover || {});
      const list = getByPath(data, this._listPath);
      if (!Array.isArray(list)) {
        console.warn("[DeclarativeSource] 发现页返回非数组:", list);
        return [];
      }

      // 首批入队 + 余量进续拉缓冲（对齐 MufanAdapter：头批供首屏，缓冲供翻到底续拉）
      const heads = [];
      const buffer = [];
      let taken = 0;
      for (const raw of list) {
        const sid = String(raw[this._mapping.videoId?.[0]] ?? raw.series_id ?? raw.video_id ?? "");
        if (sid && this._seen.has(sid)) continue;
        if (sid) this._seen.add(sid);
        const item = this._buildQueueItem(raw);
        if (!item || !item.videoId) continue;
        if (taken < this._feedEach) { heads.push(item); taken++; }
        else buffer.push(item);
      }
      this._feedBuffer = buffer;

      if (heads.length === 0) {
        throw new Error("发现页加载失败：请检查 config.json 中的 endpoints 和 listPath 配置");
      }

      return heads;
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

  // —— 翻到底续拉：发现页缓冲 ——
  appendMainQueue() {
    // 缓冲见底前预取：发现页每次请求会重排，能持续取到新剧（fire-and-forget，不阻塞本帧）
    if (this._feedBuffer.length <= this._appendBatch) this._prefetchDiscover();
    return this._feedBuffer.splice(0, this._appendBatch);
  }

  /** 后台补一批发现页卡片进缓冲（异步；发现页会重排，可能取到此前没上过队列的剧） */
  _prefetchDiscover() {
    if (this._fetchingFeed) return;
    this._fetchingFeed = true;
    Promise.resolve().then(async () => {
      try {
        const data = await this._get(this._endpoints.discover, this._params.discover || {});
        const list = getByPath(data, this._listPath);
        if (Array.isArray(list)) {
          for (const raw of list) {
            const sid = String(raw[this._mapping.videoId?.[0]] ?? raw.series_id ?? raw.video_id ?? "");
            if (sid && this._seen.has(sid)) continue;
            if (sid) this._seen.add(sid);
            const item = this._buildQueueItem(raw);
            if (item && item.videoId) this._feedBuffer.push(item);
          }
        }
      } catch { /* 后台预取失败不影响主流程 */ }
    }).finally(() => { this._fetchingFeed = false; });
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

      // 优先按配置的搜索路径取列表
      let list = getByPath(data, this._searchListPath);
      // 兼容沐凡这类按推荐位嵌套的搜索结构：data.search_tabs[*].data
      if (!Array.isArray(list) || list.length === 0) {
        const tabs = data?.search_tabs;
        if (Array.isArray(tabs)) {
          const wantTab = this._params.search?.search_tab ?? this._params.search?.tab_type;
          // 优先指定 tab；未指定时挑首个真正含视频卡的 tab，避免拿到非视频 cell
          const isVideoCell = (c) => !!(c && (c.video_data?.[0] || c.series_id || c.video_id));
          const pick = wantTab != null
            ? tabs.find((t) => String(t.tab_type) === String(wantTab))
            : tabs.find((t) => Array.isArray(t.data) && t.data.some(isVideoCell));
          if (pick && Array.isArray(pick.data)) list = pick.data;
          else {
            list = [];
            for (const t of tabs) if (Array.isArray(t.data)) list.push(...t.data.filter(isVideoCell));
          }
        }
      }
      if (!Array.isArray(list)) {
        console.warn("[DeclarativeSource] 搜索返回非数组:", list);
        return [];
      }

      const seen = new Set();
      const out = [];
      for (const cell of list) {
        // 兼容沐凡搜索 cell 结构：真正的剧集字段在 video_data[0]，其结构等同发现页卡
        const raw = cell?.video_data?.[0] ?? cell;
        const vid = this._mapField(raw, "videoId");
        const normId = String(vid ?? raw?.series_id ?? raw?.book_id ?? "");
        if (!normId || seen.has(normId)) continue;
        seen.add(normId);
        const item = this._buildQueueItem(raw);
        if (item && item.videoId) out.push(item);
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
        const bookId = this._epBook.get(itemId);
        if (!bookId) {
          // 未进过合集（如直接续播）→ 用元素携带的 collectionId 反推 book_id
          const colId = meta?.collectionId ? String(meta.collectionId).replace(/^mf-col-/, "") : "";
          if (colId) { this._epBook.set(itemId, colId); params.book_id = colId; }
          else return null; // 对齐 MufanAdapter：缺 book_id 直接放弃，避免带空参请求
        } else {
          params.book_id = bookId;
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
