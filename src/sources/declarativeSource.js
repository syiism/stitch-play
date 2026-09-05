// declarativeSource.js · 声明式视频源适配器（通用模板 + 规则解析器）
//
// 全项目唯一的视频源适配器：沐凡短剧/漫剧都只是它的一组配置实例。
// 同一套缓存、主队列 / 合集 / 懒解析流程，数据面（接口路径、固定参数、字段映射）
// 全部来自 config.json 的 sources[].config，代码不写死地址。
// 字段解析交给 ruleParser.js：mapping.items 定位元素列表（发现页/搜索共用），
// 其余字段值为规则字符串（$ 路径 / 模板插值 / 字面量 / fallback 数组，语法见 ruleParser.js 头部注释）。
//
// config 配置项：
//   endpoints: { discover, search?, directory, video? }   各接口路径；支持上下文占位符
//              {item_id}/{book_id}（如 "/api/v1/videos/{item_id}"，替换进路径且不再进 query）
//   params:    { discover?, search?, directory?, video? } 各接口固定参数（合并进请求；
//              值可含占位符插值，如 { item_ids: "{item_id}" }）
//   mapping:   规则映射，例：{ "items": "$.book_info", "videoId": "drama-$.series_id",
//              "title": "$.title", "poster": "$.cover", "collectionId": "col-$.series_id",
//              "category": "短剧" }
//   mapping.src: 取流响应中的播放地址规则（相对剥信封后响应；缺省回落 data.url ?? data.video_url）
//   collectionItemsPath: 目录响应中分集数组的路径（点号路径，如 item_data_list）
//   feedEach / appendBatch: 首屏批大小 / 翻底续拉批大小（默认 20 / 20）
//
// 归一：发现页卡 / 目录分集 → 规范 QueueItem（videoId 前缀 drama- / ep- 区分层级，
// 同一套 drama-/ep-/col- id 体系，懒解析复用同一套 item_id/book_id 推导）。

import { normalize } from "./schema.js";
import { resolveRule, resolveList } from "./ruleParser.js";

// 点号路径取值（collectionItemsPath 用；路径为普通点号，非 $ 规则）
function getByPath(obj, path) {
  if (!path || !obj) return undefined;
  let cur = obj;
  for (const k of String(path).split(".")) {
    if (cur == null || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

export class DeclarativeSource {
  constructor(opts = {}) {
    this.id = opts.id || "declarative-source";
    this.label = opts.label || "声明式视频源";
    // baseUrl：浏览器侧为同源代理前缀（opts.baseUrl），Node 测试直连传上游地址
    this._base = String(opts.baseUrl || "").replace(/\/+$/, "");
    this._defaultBase = String(opts.defaultBase || this._base).replace(/\/+$/, "");
    // 需透传给 server 的自定义 http 上游（proxy=true + 自定义 http 地址时由 index.js 传入）
    this._proxyUpstream = opts.proxyUpstream || null;

    const cfg = opts.config || {};
    this._api = { ...(cfg.endpoints || {}) };
    this._params = cfg.params || {};
    // 规则映射：mapping.items 提取为列表规则，其余字段进字段规则表（_ 开头为保留元数据）
    const mapping = cfg.mapping || {};
    this._itemsRule = mapping.items ?? null;
    this._rules = {};
    for (const [key, val] of Object.entries(mapping)) {
      if (key === "items" || key.startsWith("_")) continue;
      this._rules[key] = val;
    }
    this._collItemsPath = cfg.collectionItemsPath || null;
    // 搜索响应为 search_tabs[*] 结构时按该 tab_type 选 tab（沐凡：params.search.tab_type）
    this._searchTab = cfg.params?.search?.tab_type != null ? String(cfg.params.search.tab_type) : null;
    this._feedEach = Number(cfg.feedEach) > 0 ? Number(cfg.feedEach) : 20;
    this._appendBatch = Number(cfg.appendBatch) > 0 ? Number(cfg.appendBatch) : 20;
    this._timeout = opts.timeoutMs || 45000;

    this._videoCache = new Map(); // videoId -> QueueItem（getVideoMeta 同步读）
    this._collMeta  = new Map();  // col-<bid> -> { collectionId, title, category, poster }
    this._firstEp   = new Map();  // series_id -> 首集 item_id（发现页卡片自带 vid）
    this._epBook    = new Map();  // item_id -> book_id（分集归属剧集，取流用）
    this._buffer    = [];         // 续拉缓冲：发现页首屏未进主队列的剩余卡片
    this._seen      = new Set();  // series_id 去重
    this._collListCache = new Map(); // 合集目录缓存（含 in-flight 去重，预热订阅者写入）
    this._fetchingFeed = false;   // 后台预取进行中标记
  }

  // —— 基础请求 ——
  /** 当前 baseUrl（供 UI 回显） */
  get baseUrl() { return this._base; }
  /** 运行时覆盖 baseUrl（前端自定义）；空值回退默认代理前缀 */
  setBase(url) {
    const u = String(url || "").trim().replace(/\/+$/, "");
    if (!u) { this._base = this._defaultBase; return true; }
    if (u === this._base) return false;
    this._base = u; return true;
  }
  /** 同步需透传给 server 的自定义 http 上游（前端改地址/代理开关时更新） */
  setProxyUpstream(u) { this._proxyUpstream = u || null; }
  /** 清除自定义，回退默认代理前缀 */
  resetBase() { this._base = this._defaultBase; }
  /** 只读：源默认请求基址（sources.d 的 base，缺省同源根路径），供核心决定「走代理」时的回退地址 */
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
      // 响应 {code,msg,data} 信封自动剥离；无 data 字段（平铺对象 / 直接返回列表）原样返回
      if (json && typeof json === "object" && !Array.isArray(json) && json.data !== undefined) {
        return json.data;
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  _put(item) { this._videoCache.set(item.videoId, item); return item; }

  /** 上游返回的播放地址若带真实接口域名 → 改写为同源代理路径（绕开无 CORS 头）。
   *  仅改写 /api/ 开头的路径，避免误伤第三方 CDN 直链。 */
  _proxify(url) {
    if (!url) return null;
    const m = /^https?:\/\/[^/]+(\/api\/.*)$/.exec(String(url));
    if (!m) return url;
    const sep = m[1].includes("?") ? "&" : "?";
    const up = this._proxyUpstream ? `${sep}proxy_upstream=${encodeURIComponent(this._proxyUpstream)}` : "";
    return this._base + m[1] + up;
  }

  // —— 字段规则求值（$ 路径 / 模板插值 / 字面量 / fallback 数组，见 ruleParser.js）——
  _field(raw, fieldKey) {
    const rule = this._rules[fieldKey];
    return rule == null ? undefined : resolveRule(raw, rule);
  }

  // —— 端点/参数的上下文占位符（{item_id}/{book_id}/{keyword}）——
  /** 端点路径占位符替换："/api/v1/videos/{item_id}" + ctx → "/api/v1/videos/123"（缺失保留原样） */
  _fillPath(ep, ctx) {
    return String(ep || "").replace(/\{(item_id|book_id|keyword)\}/g, (m, k) =>
      ctx[k] != null && ctx[k] !== "" ? String(ctx[k]) : m);
  }
  /** 请求参数组装：params 值做占位符插值；端点路径或 params 已消费的上下文键不再进 query，
   *  其余（旧式 query 语义，如沐凡 /api/directory?book_id=）自动追加。 */
  _fillParams(base, ctx, ep) {
    const out = {};
    const used = new Set();
    String(ep || "").replace(/\{(item_id|book_id|keyword)\}/g, (m, k) => { if (ctx[k] != null && ctx[k] !== "") used.add(k); return m; });
    for (const [k, v] of Object.entries(base || {})) {
      if (typeof v === "string" && v.includes("{")) {
        out[k] = v.replace(/\{(item_id|book_id|keyword)\}/g, (m, kk) => {
          if (ctx[kk] != null && ctx[kk] !== "") { used.add(kk); return String(ctx[kk]); }
          return m;
        });
      } else out[k] = v;
    }
    for (const k of Object.keys(ctx)) {
      if (!(k in out) && !used.has(k) && ctx[k] != null && ctx[k] !== "") out[k] = ctx[k];
    }
    return out;
  }

  // —— 发现页卡 / 搜索 cell → 规范 QueueItem ——
  _buildQueueItem(raw, collectionId = null, episodeIndex = null) {
    const videoId = this._field(raw, "videoId");
    if (!videoId) return null;
    const shaped = {
      videoId:      String(videoId),
      title:        String(this._field(raw, "title") ?? raw.title ?? raw.name ?? "未命名"),
      src:          String(raw.src ?? raw.url ?? ""), // 懒解析：未命中留空
      poster:       this._field(raw, "poster") ?? raw.poster ?? raw.cover ?? null,
      duration:     this._field(raw, "duration") ?? raw.duration ?? raw.dur ?? null,
      collectionId: this._field(raw, "collectionId") ?? collectionId,
      episodeIndex,
      category:     this._field(raw, "category") ?? raw.category ?? raw.kind ?? null,
    };
    if (shaped.collectionId) {
      this._collMeta.set(shaped.collectionId, {
        collectionId: shaped.collectionId,
        title: shaped.title,
        category: shaped.category,
        poster: shaped.poster,
      });
    }
    // 发现页卡自带首集 id（如沐凡 card.vid）→ 记录，供 drama-* 懒解析直接定位
    const sid = String(raw.series_id ?? "");
    if (sid && raw.vid) this._firstEp.set(sid, String(raw.vid));
    return this._put(normalize(shaped, null, this.id));
  }

  // —— 主队列：发现页 ——
  async listMainQueue() {
    // 每次拉取都是一次全新发现页请求（上游会重排），去重只在本轮内生效；
    // 否则切走再切回时所有剧都“已见过”，主队列会错误地变空
    this._seen = new Set();
    const data = await this._discoverPage();
    const list = resolveList(data, this._itemsRule);
    if (!Array.isArray(list)) {
      throw new Error("发现页返回非数组：请检查 config.mapping.items 规则");
    }
    const heads = [];
    const buffer = [];
    let taken = 0;
    for (const cell of list) {
      // 兼容搜索型发现页 cell：剧集字段包在 video_data[0]（无则原样）
      const raw = cell?.video_data?.[0] ?? cell;
      const sid = String(this._field(raw, "videoId") ?? "");
      if (sid && this._seen.has(sid)) continue;
      if (sid) this._seen.add(sid);
      const item = this._buildQueueItem(raw);
      if (!item) continue;
      if (taken < this._feedEach) { heads.push(item); taken++; }
      else buffer.push(item);
    }
    this._buffer = buffer;
    if (heads.length === 0) {
      throw new Error("发现页加载失败：请检查 config.json 的 endpoints/params/mapping 配置");
    }
    // 首屏即整页（响应条数 ≥ feedEach 且缓冲空）→ 立即预取下一批，避免首次续拉空窗。
    // 响应不满页（如推荐流型发现页每次只回少数几张卡、且无翻页游标）不预取：再请求也拿不到新货。
    if (buffer.length === 0 && list.length >= this._feedEach) this._prefetchDiscover();
    return heads;
  }

  /** 发现页单页拉取：合并 params.discover 固定参数 */
  async _discoverPage() {
    return this._get(this._api.discover, { ...(this._params.discover || {}) });
  }

  // —— 翻到底续拉：发现页缓冲 ——
  appendMainQueue() {
    // 缓冲见底前预取：发现页每次请求会重排，能持续取到新剧（fire-and-forget，不阻塞本帧）
    if (this._buffer.length <= this._appendBatch) this._prefetchDiscover();
    return this._buffer.splice(0, this._appendBatch);
  }

  /** 后台补一批发现页卡片进缓冲（异步；发现页会重排，可能取到此前没上过队列的剧） */
  _prefetchDiscover() {
    if (this._fetchingFeed) return;
    this._fetchingFeed = true;
    this._discoverPage()
      .then((data) => {
        const list = resolveList(data, this._itemsRule);
        if (!Array.isArray(list)) return;
        for (const cell of list) {
          const raw = cell?.video_data?.[0] ?? cell;
          const sid = String(this._field(raw, "videoId") ?? "");
          if (sid && this._seen.has(sid)) continue;
          if (sid) this._seen.add(sid);
          const item = this._buildQueueItem(raw);
          if (item) this._buffer.push(item);
        }
      })
      .catch(() => { /* 后台预取失败不影响主流程 */ })
      .finally(() => { this._fetchingFeed = false; });
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
    const bid = String(collectionId).replace(/^col-/, "");
    const ctx = { book_id: bid };
    const data = await this._get(this._fillPath(this._api.directory, ctx), this._fillParams(this._params.directory, ctx, this._api.directory));
    const list = this._collItemsOf(data);
    const meta = this._collMeta.get(collectionId);
    const title = meta?.title || bid;
    const category = meta?.category || null;
    const items = list.map((ep, i) => {
      const itemId = this._itemIdOf(ep);
      if (itemId) this._epBook.set(itemId, bid); // 分集归属剧集，取流用
      return this._put(normalize({
        videoId:      itemId ? `ep-${itemId}` : "",
        title:        `${title} · ${ep.title || `第${i + 1}集`}`,
        src:          "",
        poster:       meta?.poster ?? null,
        duration:     null,
        collectionId,
        episodeIndex: i,
        category,
      }, null, this.id));
    }).filter((it) => it.videoId);
    return { collectionId, title, items, startPointer: 0 }; // 起播指针恒 0：内核 onLoadSuccess 按入口（resume/autoEnter/manual）自行决定起始集
  }

  // —— 目录响应提取分集数组（collectionItemsPath 点号路径）——
  _collItemsOf(data) {
    const items = this._collItemsPath ? getByPath(data, this._collItemsPath) : undefined;
    return Array.isArray(items) ? items : [];
  }

  /** 分集 id（沐凡目录项为 item_id） */
  _itemIdOf(raw) {
    return String(raw?.item_id ?? "");
  }

  /** 搜索：按本源语义搜索并归一化为 QueueItem。
   *  列表定位优先 mapping.items（响应结构同发现页的源）；未命中时降级扫 search_tabs[*].data
   *  （沐凡式搜索响应，cell 包在 video_data[0]），按 params.search.tab_type 选 tab。
   *  搜索结果不污染发现流去重（_seen）。 */
  async search(keyword) {
    const kw = String(keyword || "").trim();
    if (!kw) return [];
    try {
      const data = await this._get(this._api.search, { ...(this._params.search || {}), key: kw });
      let list = resolveList(data, this._itemsRule);
      if (!Array.isArray(list) || list.length === 0) {
        const tabs = data?.search_tabs;
        if (Array.isArray(tabs)) {
          const pick = this._searchTab != null
            ? tabs.find((t) => String(t.tab_type) === this._searchTab)
            : tabs.find((t) => Array.isArray(t.data) && t.data.length > 0);
          if (pick && Array.isArray(pick.data)) list = pick.data;
          else {
            list = [];
            for (const t of tabs) if (Array.isArray(t.data)) list.push(...t.data);
          }
        }
      }
      if (!Array.isArray(list)) return [];
      const seen = new Set();
      const out = [];
      for (const cell of list) {
        const raw = cell?.video_data?.[0] ?? cell;
        const vid = String(this._field(raw, "videoId") ?? "");
        if (!vid || seen.has(vid)) continue;
        seen.add(vid);
        const item = this._buildQueueItem(raw);
        if (item) out.push(item);
      }
      return out;
    } catch (e) {
      console.warn("[DeclarativeSource] 搜索失败:", e.message);
      return [];
    }
  }

  // —— 懒解析可播放地址（player 起播时调用）——
  async resolveSrc(videoId) {
    // 卡片/分集已带可播地址（raw.src/raw.url 或上次取流回填）→ 直接返回，不再请求
    const meta = this._videoCache.get(videoId);
    if (meta?.src) return meta.src;
    if (!this._api.video) return meta?.src || null;
    try {
      let itemId, bookId;
      if (videoId.startsWith("ep-")) {
        itemId = videoId.slice(3);
        bookId = this._epBook.get(itemId) || (meta?.collectionId ? String(meta.collectionId).replace(/^col-/, "") : "");
        if (!bookId) return null;
      } else if (videoId.startsWith("drama-")) {
        const sid = videoId.slice(6);
        itemId = this._firstEp.get(sid);
        if (!itemId) {
          // 卡片未带首集 → 拉目录取第一集
          const dctx = { book_id: sid };
          const data = await this._get(this._fillPath(this._api.directory, dctx), this._fillParams(this._params.directory, dctx, this._api.directory));
          const list = this._collItemsOf(data);
          if (!list.length) return null;
          itemId = this._itemIdOf(list[0]);
          this._firstEp.set(sid, itemId);
          this._epBook.set(itemId, sid);
        }
        bookId = sid;
      } else {
        return meta?.src || null;
      }
      const vctx = { item_id: itemId, book_id: bookId };
      const data = await this._get(this._fillPath(this._api.video, vctx), this._fillParams(this._params.video, vctx, this._api.video));
      // 取流地址提取：mapping.src 规则优先（相对剥信封后的取流响应），缺省回落常见键
      let url = this._rules.src != null ? resolveRule(data, this._rules.src) : (data.url ?? data.video_url ?? null);
      if (Array.isArray(url)) url = url.find((v) => typeof v === "string" && v) ?? null; // 对象通配命中多条取首个
      url = this._proxify(url);
      if (!url) return null;
      // 回填元数据（时长/封面），供预加载与 UI 使用
      if (meta) {
        meta.src = url;
        if (data.pic && !meta.poster) meta.poster = data.pic;
        if (typeof data.duration === "number" && data.duration > 0) meta.duration = data.duration;
      }
      return url;
    } catch (e) {
      console.warn("[DeclarativeSource] resolveSrc 失败:", videoId, e.message);
      return null;
    }
  }

  // —— 同步读（内核渲染 / 播放用）——
  getVideoMeta(videoId) { return this._videoCache.get(videoId) || null; }
  getCollectionMeta(collectionId) {
    return this._collMeta.get(collectionId) || { collectionId, title: collectionId };
  }
}
