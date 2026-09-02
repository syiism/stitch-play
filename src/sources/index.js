// index.js · 视频源兼容层入口：从 config.json 注册所有适配器、暴露统一访问点
//
// 内核（状态机 / 播放器 / UI / 预加载）只从这里取「当前激活源」：
//   import { activeSource, listSources } from "./sources/index.js";
// 新增视频源：实现 adapter.js 契约 → 在 config.json 的 sources 里加一段描述即可，内核零改动。
// 源定义改为运行时初始化（initSources），数据源/上游/接口路径不再硬编码在代码里。

import { registry, activeSource, listSources, SourceRegistry } from "./adapter.js";
import { MufanAdapter } from "./mufanAdapter.js";
import { CONFIG } from "../config.js";
import { getBaseUrl, setBaseUrl } from "../sourcePrefs.js";

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
    if (s.mode !== "mufan") continue; // 未来可在下方按 mode 分派其它适配器
    const defaultBase = proxyBase[s.proxy] || `/${String(s.proxy || "").replace(/^\/+|\/+$/g, "")}`;
    // 用户自定义覆盖优先（localStorage 持久化；无则回退默认代理前缀）
    const override = getBaseUrl(s.id);
    registry.register(new MufanAdapter({
      id: s.id,
      label: s.label,
      category: s.category,
      baseUrl: override || defaultBase,
      defaultBase,
      tabs,
      api,
      timeoutMs: timeout,
    }));
  }
  // 首个注册者默认激活
  if (!registry.active()) registry.use("mufan-short");
}

/** 前端自定义某源的 baseUrl 并立即应用到已注册适配器。
 *  返回最终生效的 baseUrl（清除自定义时回退默认、返回 null）。 */
export function setSourceBase(id, url) {
  const val = setBaseUrl(id, url);   // 持久化到 localStorage
  const a = registry.get(id);
  if (a && typeof a.setBase === "function") {
    if (val) a.setBase(val); else a.resetBase?.();
  }
  return val;
}

export { registry, activeSource, listSources, SourceRegistry };
export { getBaseUrl } from "../sourcePrefs.js"; // 供 UI 回显当前覆盖值
export { MufanAdapter } from "./mufanAdapter.js";
export { normalize, QUEUE_ITEM_SCHEMA } from "./schema.js";