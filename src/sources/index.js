// index.js · 视频源兼容层入口：从 config.json 注册所有适配器、暴露统一访问点
//
// 内核（状态机 / 播放器 / UI / 预加载）只从这里取「当前激活源」：
//   import { activeSource, listSources } from "./sources/index.js";
// 新增视频源：实现 adapter.js 契约 → 在 config.json 的 sources 里加一段描述即可，内核零改动。
// 源定义改为运行时初始化（initSources），数据源/上游/接口路径不再硬编码在代码里。

import { registry, activeSource, listSources, SourceRegistry } from "./adapter.js";
import { MufanAdapter } from "./mufanAdapter.js";
import { DeclarativeSource } from "./declarativeSource.js";
import { CONFIG } from "../config.js";
import { getBaseUrl, getProxy, setBaseUrl, setProxy } from "../sourcePrefs.js";

/** 根据 proxy 开关与自定义地址计算最终 baseUrl。
 *  - proxy=false + 有自定义 → 直连自定义地址
 *  - proxy=false + 无自定义 → 默认同源代理前缀
 *  - proxy=true  + https 自定义 → 直接直连（无混合内容风险）
 *  - proxy=true  + http/无自定义 → 默认同源代理前缀（上游地址由 server env 决定） */
function resolveBaseUrl(override, forceProxy, defaultBase) {
  if (forceProxy) {
    if (override && /^https:\/\//i.test(override)) return override; // https → 直连
    return defaultBase; // http 或无自定义 → 走静态代理前缀，上游由 server 端 env 配置
  }
  return override || defaultBase;
}

/** 分集标题合成：元素是合集分集（有 collectionId + episodeIndex）时返回「剧名 + 第N集」，
 *  用于退出合集后主队列元素与历史记录的展示；非分集元素原样返回其标题。
 *  （合集队列内仍使用元素自身标题“第N集”，由 UI 单独处理，不经过本函数。） */
export function episodeDisplayTitle(src, meta) {
  if (!meta) return "";
  const hasEp = meta.collectionId && meta.episodeIndex != null;
  if (hasEp) {
    const def = src?.getCollectionMeta ? src.getCollectionMeta(meta.collectionId) : null;
    if (def && def.title) {
      return `${def.title} 第${Number(meta.episodeIndex) + 1}集`;
    }
  }
  return meta.title || "";
}

/** 从运行时配置注册视频源（loadConfig 之后调用）。
 *  源定义缺省时回退到两套 mufan 源，保证无 config.json 也能跑。 */
export async function initSources(runtime) {
  const cfg = runtime || CONFIG.runtime;
  const sources = cfg?.sources?.length ? cfg.sources : [
    { id: "mufan-short", label: "沐凡 · 短剧", category: "short", mode: "mufan", proxy: "mf" },
    { id: "mufan-manju", label: "沐凡 · 漫剧", category: "manju", mode: "mufan", proxy: "mf" },
  ];
  const tabs = cfg?.tabs;
  const api = cfg?.mufan_api;
  const timeout = cfg?.request?.timeout_ms;
  const proxyBase = cfg?._proxyBase || {};

  for (const s of sources) {
    const defaultBase = proxyBase[s.proxy] || `/${String(s.proxy || "").replace(/^\/+|\/+$/g, "")}`;
    const override = getBaseUrl(s.id);
    const forceProxy = getProxy(s.id);
    const baseUrl = resolveBaseUrl(override, forceProxy, defaultBase);

    if (s.mode === "declarative") {
      // 声明式配置源（通用模板）
      registry.register(new DeclarativeSource({
        id: s.id,
        label: s.label,
        baseUrl,
        defaultBase,
        config: s.config || {},
        timeoutMs: timeout,
      }));
    } else if (s.mode === "mufan" || !s.mode) {
      // 沐凡源（向后兼容：无 mode 字段默认当 mufan 处理）
      registry.register(new MufanAdapter({
        id: s.id,
        label: s.label,
        category: s.category,
        baseUrl,
        defaultBase,
        tabs,
        api,
        timeoutMs: timeout,
      }));
    }
    // 未来可在此添加更多 mode 分支，如 "custom"、"hls" 等
  }
  // 首个注册者默认激活
  if (!registry.active() && registry.list().length > 0) {
    registry.use(registry.list()[0].id);
  }
}

/** 前端自定义某源的 baseUrl + 是否启用代理，并立即应用到已注册适配器。
 *  proxy=true + https 自定义 → 直接直连。
 *  proxy=true + http/无自定义 → 走静态代理前缀（上游由 server env 配置）。 */
export function setSourceBase(id, url, proxy) {
  const val = setBaseUrl(id, url);                     // 持久化 baseUrl
  if (typeof proxy === "boolean") setProxy(id, proxy); // 持久化代理开关
  const a = registry.get(id);
  if (a && typeof a.setBase === "function") {
    const useProxy = (typeof proxy === "boolean" ? proxy : getProxy(id));
    const resolved = resolveBaseUrl(val, useProxy, a.defaultBase);
    if (resolved) a.setBase(resolved);   // setBase 内部已处理「值未变」的 no-op
    else a.resetBase?.();
  }
  return val;
}

export { registry, activeSource, listSources, SourceRegistry };
export { getBaseUrl, getProxy } from "../sourcePrefs.js"; // 供 UI 回显当前覆盖值与代理开关
export { MufanAdapter } from "./mufanAdapter.js";
export { DeclarativeSource } from "./declarativeSource.js";
export { normalize, QUEUE_ITEM_SCHEMA } from "./schema.js";