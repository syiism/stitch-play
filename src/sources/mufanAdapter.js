// mufanAdapter.js · 沐凡源（短剧/漫剧）
//
// 接口与上游全部来自运行时配置（config.json → CONFIG.runtime / 构造 opts），代码不硬编码地址路径：
//   主队列   = discover  发现页 /api/bookmall/cell/change?genre_tab=N
//   搜索     = search    搜索 /api/search?key=&tab_type=N
//   合集     = directory 剧集目录 /api/directory?book_id=（一部剧 = 一个合集，分集 = EP）
//   取流     = video     取流 /api/video?item_id&book_id&type=json&proxy=1（懒解析：起播时才取）
//
// 归一：发现页卡片 / 目录分集 → 规范 QueueItem（videoId 前缀 mf-drama- / mf-ep- 区分层级）。
// 注意：上游无 CORS 头，浏览器部署须经同源代理（tools/server.py 按 config.json 的 proxies 生成 /<prefix>/*）；
//       浏览器侧 baseUrl 传代理前缀（如 "/mf"），Node 测试可直连传 upstream。

import { normalize } from "./schema.js";
import { CONFIG } from "../config.js";

const MF = CONFIG.sources.mufan;

const CAT_LABEL = { short: "短剧", manju: "漫剧" };

// —— 内置默认（loadConfig 兜底；与 config.example.json 对齐）——
const DEF_API = {
  discover: "/api/bookmall/cell/change",
  search: "/api/search",
  directory: "/api/directory",
  video: "/api/video",
};
const DEF_TABS = {
  short: { genre_tab: 4, search_tab: 11 },
  manju: { genre_tab: 5, search_tab: 19 },
};

export class MufanAdapter {
  constructor(opts = {}) {
    // 实例化为单分类源（mufan-short / mufan-manju）；缺省 category = 混合发现页
    const cat = opts.category || null;
    this._cat = cat && CAT_LABEL[cat] ? cat : null;
    this._cats = this._cat ? [this._cat] : Object.keys(CAT_LABEL);
    this.id = opts.id || (this._cat ? `mufan-${this._cat}` : "mufan");
    this.label = opts.label || (this._cat ? `沐凡 · ${CAT_LABEL[this._cat]}` : "沐凡（短剧/漫剧 · 发现页）");
    // baseUrl：浏览器侧为同源代理前缀（opts.baseUrl，如 "/mf"），Node 测试直连传上游地址
    this._base = String(opts.baseUrl || MF.baseUrl).replace(/\/+$/, "");
    this._defaultBase = String(opts.defaultBase || this._base).replace(/\/+$/, "");
    // 需透传给 server 的自定义 http 上游（proxy=true + 自定义 http 地址时由 index.js 传入）
    this._proxyUpstream = opts.proxyUpstream || null;
    this._api = { ...DEF_API, ...(opts.api || {}) };
    this._tabs = { ...DEF_TABS, ...(opts.tabs || {}) };
    this._timeout = opts.timeoutMs || MF.requestTimeoutMs;
    this._tabFor = (k) => this._tabs[k] || DEF_TABS[k] || { genre_tab: 4, search_tab: 11 };
    this._videoCache = new Map(); // videoId -> QueueItem（getVideoMeta 同步读）
    this._collMeta  = new Map();  // mf-col-<bid> -> { collectionId, title, category }
    this._firstEp   = new Map();  // series_id -> 首集 item_id（发现页卡片自带 vid）
    this._epBook    = new Map();  // item_id -> book_id（分集归属剧集，取流用）
    this._history   = new Map();  // book_id -> 已看下标（会话级历史定位）
    this._buffer    = [];         // 续拉缓冲：发现页首屏未进主队列的剩余卡片
    this._seen      = new Set();  // series_id 去重
    this._collListCache = new Map(); // 合集目录缓存（含 in-flight 去重，预热订阅者写入）
  }

  // —— 基础请求 ——
  /** 当前 baseUrl（供 UI 回显） */
  get baseUrl() { return this._base; }
  /** 运行时覆盖 baseUrl（前端自定义）；空值回退默认代理前缀 */
  setBase(url) {
    // 有值时用绝对/相对地址；空值时回退到默认（同源代理前缀）
    const u = String(url || "").trim().replace(/\/+$/, "");
    if (!u) { this._base = this._defaultBase; return true; }
    if (u === this._base) return false;
    this._base = u; return true;
  }
  /** 同步需透传给 server 的自定义 http 上游（前端改地址/代理开关时更新） */
  setProxyUpstream(u) { this._proxyUpstream = u || null; }
  /** 清除自定义，回退默认代理前缀 */
  resetBase() { this._base = this._defaultBase; }
  /** 只读：同源代理前缀（如 /mf），供核心决定「走代理」时的回退地址 */
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
      if (!resp.ok) throw new Error(`http-${resp.status}`); // 先检状态，避免把错误页/空响应喂给 json() 报出费解的解析错误
      const json = await resp.json();
      if (json.code !== 0) throw new Error(`api-code-${json.code}`);
      return json.data || {};
    } finally {
      clearTimeout(timer);
    }
  }

  _put(item) { this._videoCache.set(item.videoId, item); return item; }

  /** 上游返回的播放地址是带真实接口域名的绝对 URL（如 http://<上游>/api/video_decrypt?…）。
   *  改写为同源代理路径：既不让接口地址进入前端，也绕开上游无 CORS 头导致的播放失败。
   *  仅改写 /api/ 开头的路径，避免误伤第三方 CDN 直链。 */
  _proxify(url) {
    if (!url) return null;
    const m = /^https?:\/\/[^/]+(\/api\/.*)$/.exec(String(url));
    if (!m) return url;
    const sep = m[1].includes("?") ? "&" : "?";
    const up = this._proxyUpstream ? `${sep}proxy_upstream=${encodeURIComponent(this._proxyUpstream)}` : "";
    return this._base + m[1] + up;
  }

  _catLabel(k) { return CAT_LABEL[k] || "剧集"; }

  // —— 发现页卡片 → 剧集头（规范 QueueItem；src 待懒解析）——
  _fromFeedCard(raw, catKey) {
    const sid = String(raw.series_id ?? "");
    if (sid && raw.vid) this._firstEp.set(sid, String(raw.vid)); // 首集 id 直接来自卡片
    const catLabel = this._catLabel(catKey);
    const shaped = {
      videoId:      sid ? `mf-drama-${sid}` : "",
      title:        raw.title ?? "未命名剧集",
      src:          "",            // 懒解析：resolveSrc() 经 /api/video 取流
      poster:       raw.cover ?? null,
      duration:     null,          // 单集时长未知 → 预加载走默认阈值
      collectionId: sid ? `mf-col-${sid}` : null,
      episodeIndex: null,
      category:     catLabel,      // 短剧 / 漫剧
    };
    if (shaped.collectionId) {
      this._collMeta.set(shaped.collectionId, { collectionId: shaped.collectionId, title: shaped.title, category: catLabel });
    }
    return this._put(normalize(shaped, null, this.id));
  }

  // —— 主队列：发现页（短剧 + 漫剧 交错）——
  async listMainQueue() {
    // 每次拉取都是一次全新发现页请求（上游会重排），去重只在本轮内生效；
    // 否则切走再切回时所有剧都“已见过”，主队列会错误地变空
    this._seen = new Set();
    const feeds = await Promise.all(this._cats.map(async (catKey) => {
      try {
        const data = await this._get(this._api.discover, { genre_tab: this._tabFor(catKey).genre_tab, algo_type: 101 });
        return { catKey, cards: data.book_info || [] };
      } catch (e) {
        console.warn(`[Mufan] 发现页(${this._catLabel(catKey)})加载失败:`, e.message);
        return { catKey, cards: [] };
      }
    }));

    const perCat = new Map(this._cats.map((c) => [c, []]));
    const restPerCat = new Map(this._cats.map((c) => [c, []]));
    for (const { catKey, cards } of feeds) {
      let taken = 0;
      for (const card of cards) {
        const sid = String(card.series_id ?? "");
        if (!sid || this._seen.has(sid)) continue;
        this._seen.add(sid);
        const item = this._fromFeedCard(card, catKey);
        if (!item.videoId) continue;
        if (taken < MF.feedEach) { perCat.get(catKey).push(item); taken++; }
        else restPerCat.get(catKey).push(item);
      }
    }
    // 交错排列：短剧、漫剧 交替（可视化区分两类）
    const zip = (arrs) => {
      const out = [];
      const n = Math.max(...arrs.map((a) => a.length));
      for (let i = 0; i < n; i++) for (const a of arrs) if (a[i]) out.push(a[i]);
      return out;
    };
    const heads = zip(this._cats.map((c) => perCat.get(c)));
    if (heads.length === 0) {
      // 两类发现页都失败：最常见原因是没走同源代理（用 http.server 裸启动）
      throw new Error("发现页加载失败：请用 tools/server.py 启动（含同源代理前缀 /mfs /mfm），而非 http.server");
    }

    // 续拉缓冲同样交错
    this._buffer = zip(this._cats.map((c) => restPerCat.get(c)));
    return heads;
  }

  // —— 合集：剧集目录（一部剧 = 一个合集）——
  async listCollection(collectionId) {
    // 命中缓存（含预热写入 / in-flight 复用）：剧集目录基本不变，预取后进入合集即时返回
    if (this._collListCache.has(collectionId)) return this._collListCache.get(collectionId);
    const p = this._fetchCollection(collectionId)
      .then((r) => {
        if (r.items.length > 0) this._collListCache.set(collectionId, r);
        else this._collListCache.delete(collectionId);
        return r;
      })
      .catch((e) => { this._collListCache.delete(collectionId); throw e; });
    this._collListCache.set(collectionId, p);
    return p;
  }

  async _fetchCollection(collectionId) {
    const bid = String(collectionId).replace(/^mf-col-/, "");
    const data = await this._get(this._api.directory, { book_id: bid });
    const list = data.item_data_list || [];
    const meta = this._collMeta.get(collectionId);
    const title = meta?.title || bid;
    const catLabel = meta?.category || "剧集";
    const items = list.map((ep, i) => {
      const itemId = String(ep.item_id ?? "");
      this._epBook.set(itemId, bid);
      return this._put(normalize({
        videoId:      `mf-ep-${itemId}`,
        title:        `${title} · ${ep.title || `第${i + 1}集`}`,
        src:          "",
        poster:       meta?.raw?.cover ?? null,
        duration:     null,
        collectionId,
        episodeIndex: i,
        category:     catLabel,
      }, null, this.id));
    });
    return { collectionId, title, items, startPointer: this._history.get(bid) ?? 0 };
  }

  // —— 翻到底续拉：发现页缓冲（上游 offset 被忽略，用首屏剩余卡片）——
  appendMainQueue() {
    // 缓冲见底前预取：发现页每次请求会重排，能持续取到新剧（fire-and-forget，不阻塞本帧）
    if (this._buffer.length <= MF.appendBatch) this._prefetchDiscover();
    return this._buffer.splice(0, MF.appendBatch);
  }

  /** 搜索：按本源语义搜索并归一化为 QueueItem。
   *  单分类实例（mufan-short/manju）只搜本类（tab_type 11/19）；混合实例搜两类合并。
   *  搜索结果不污染发现流去重（_seen），解析复用 _fromFeedCard（同结构：series_id/vid/title/cover）。 */
  async search(keyword) {
    const kw = String(keyword || "").trim();
    if (!kw) return [];
    const results = await Promise.all(this._cats.map(async (catKey) => {
      const searchTab = this._tabFor(catKey).search_tab;
      try {
        const data = await this._get(this._api.search, { key: kw, tab_type: searchTab });
        const list = (data.search_tabs || []).find((t) => String(t.tab_type) === String(searchTab))?.data;
        if (!Array.isArray(list)) return [];
        const seen = new Set();
        const out = [];
        for (const cell of list) {
          const vd = cell.video_data?.[0];
          if (!vd) continue;
          const sid = String(vd.series_id ?? cell.book_id ?? "");
          if (!sid || seen.has(sid)) continue;
          seen.add(sid);
          const item = this._fromFeedCard({
            series_id: sid,
            vid: String(vd.vid ?? ""),
            title: vd.title ?? vd.raw_book_name ?? "未命名剧集",
            cover: vd.cover ?? null,
          }, catKey);
          if (item.videoId) out.push(item);
        }
        return out;
      } catch (e) {
        console.warn(`[Mufan] 搜索(${this._catLabel(catKey)})失败:`, e.message);
        return [];
      }
    }));
    return results.flat();
  }

  /** 后台补一批发现页卡片进缓冲（异步；发现页会重排，可能取到此前没上过队列的剧） */
  _prefetchDiscover() {
    if (this._fetchingFeed) return;
    this._fetchingFeed = true;
    Promise.all(this._cats.map(async (catKey) => {
      try {
        const data = await this._get(this._api.discover, { genre_tab: this._tabFor(catKey).genre_tab, algo_type: 101 });
        return { catKey, cards: data.book_info || [] };
      } catch { return { catKey, cards: [] }; }
    })).then((feeds) => {
      for (const { catKey, cards } of feeds) {
        for (const card of cards) {
          const sid = String(card.series_id ?? "");
          if (!sid || this._seen.has(sid)) continue;
          this._seen.add(sid);
          const item = this._fromFeedCard(card, catKey);
          if (item.videoId) this._buffer.push(item);
        }
      }
    }).finally(() => { this._fetchingFeed = false; });
  }

  // —— 懒解析可播放地址（player 起播时调用）——
  async resolveSrc(videoId) {
    try {
      let itemId, bookId;
      if (videoId.startsWith("mf-ep-")) {
        itemId = videoId.slice(6);
        bookId = this._epBook.get(itemId);
        if (!bookId) return null;
      } else if (videoId.startsWith("mf-drama-")) {
        const sid = videoId.slice(9);
        itemId = this._firstEp.get(sid);
        if (!itemId) {
          // 卡片未带首集 → 拉目录取第一集
          const data = await this._get(this._api.directory, { book_id: sid });
          const list = data.item_data_list || [];
          if (!list.length) return null;
          itemId = String(list[0].item_id);
          this._firstEp.set(sid, itemId);
          this._epBook.set(itemId, sid);
        }
        bookId = sid;
      } else {
        return null;
      }
      const data = await this._get(this._api.video, { item_id: itemId, book_id: bookId, type: "json", proxy: 1 });
      const url = this._proxify(data.url || data.video_url || null);
      if (!url) return null;
      // 回填元数据（时长/封面），供预加载与 UI 使用
      const meta = this._videoCache.get(videoId);
      if (meta) {
        meta.src = url;
        if (data.pic && !meta.poster) meta.poster = data.pic;
        if (typeof data.duration === "number" && data.duration > 0) meta.duration = data.duration;
      }
      return url;
    } catch (e) {
      console.warn("[Mufan] resolveSrc 失败:", videoId, e.message);
      return null;
    }
  }

  // —— 同步读（内核渲染 / 播放用）——
  getVideoMeta(videoId) { return this._videoCache.get(videoId) || null; }
  getCollectionMeta(collectionId) {
    return this._collMeta.get(collectionId) || { collectionId, title: collectionId };
  }
}
