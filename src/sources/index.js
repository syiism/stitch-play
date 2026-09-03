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
    // 用户自定义覆盖优先（localStorage 持久化；无则回退默认代理前缀）
    const override = getBaseUrl(s.id);
    // 「启用代理」开启时即使填了绝对直链也只用同源代理前缀（https 页面规避混合内容）
    const baseUrl = (getProxy(s.id) ? defaultBase : (override || defaultBase));

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
 *  url 非空→覆盖直链；proxy 为 boolean 时更新「启用代理」开关；返回值见 getBaseUrl。
 *  启用代理时忽略绝对直链，只用同源代理前缀（https 页面规避 http 直链被拦）。 */
export function setSourceBase(id, url, proxy) {
  const val = setBaseUrl(id, url);                     // 持久化 baseUrl
  if (typeof proxy === "boolean") setProxy(id, proxy); // 持久化代理开关
  const a = registry.get(id);
  if (a && typeof a.setBase === "function") {
    const useProxy = (typeof proxy === "boolean" ? proxy : getProxy(id));
    if (useProxy) a.resetBase();                        // 走同源代理前缀
    else if (val) a.setBase(val);                       // 直连自定义地址
    else a.resetBase?.();
  }
  return val;
}

export { registry, activeSource, listSources, SourceRegistry };
export { getBaseUrl, getProxy } from "../sourcePrefs.js"; // 供 UI 回显当前覆盖值与代理开关
export { MufanAdapter } from "./mufanAdapter.js";
export { DeclarativeSource } from "./declarativeSource.js";
export { normalize, QUEUE_ITEM_SCHEMA } from "./schema.js";