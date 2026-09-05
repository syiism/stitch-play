// index.js · 视频源兼容层入口：从 config.json 注册所有适配器、暴露统一访问点
//
// 内核（状态机 / 播放器 / UI / 预加载）只从这里取「当前激活源」：
//   import { activeSource, listSources } from "./sources/index.js";
// 新增视频源：在 sources.d/ 下新建一个源 JSON 文件（mode: "declarative" + config）即可，
// 零代码接入。源定义改为运行时初始化（initSources），数据源/上游/接口路径不再硬编码在代码里。
// 所有源统一走 DeclarativeSource（通用模板）；沐凡短剧/漫剧只是它的一组配置实例。

import { registry, activeSource, listSources, SourceRegistry } from "./adapter.js";
import { DeclarativeSource } from "./declarativeSource.js";
import { CONFIG } from "../config.js";
import { getRuntime } from "../runtimeConfig.js";
import { getBaseUrl, getProxy, setBaseUrl, setProxy, listCustomSources } from "../sourcePrefs.js";

/** 透传上游：proxy=true + 有可用上游（自定义地址或源默认 base，不限协议）→
 *  请求改发同源根路径，把上游通过 URL 查询参数 ?proxy_upstream= 交给本地 server 同源转发。
 *  返回去尾斜杠的上游地址，否则 null。 */
function proxyUpstreamFor(upstream, forceProxy) {
  if (forceProxy && upstream) return String(upstream).trim().replace(/\/+$/, "");
  return null;
}

/** 根据 proxy 开关计算最终 baseUrl。
 *  - proxyUpstream 非空（= proxy=true 且有上游）→ 请求发同源根路径（""，即 window.location），
 *    由 server 依据 URL 里的 ?proxy_upstream= 代理转发。
 *  - 否则：有自定义地址 → 直连该地址；无 → 回退 defaultBase（源定义 base，缺省同源根路径）。 */
function resolveBaseUrl(override, proxyUpstream, defaultBase) {
  if (proxyUpstream) return "";
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

/** 注册单个源定义（config 源与本机自定义源共用同一路径） */
function registerSource(s, timeoutMs) {
  // 默认直连地址：源定义里可选的 base（完整 http(s)://）；无则空串。
  // 走代理完全由前端 proxy_upstream 参数驱动，不依赖前缀路由。
  const defaultBase = String(s.base || "").trim().replace(/\/+$/, "");
  const override = getBaseUrl(s.id);
  const forceProxy = getProxy(s.id);
  const proxyUpstream = proxyUpstreamFor(override || defaultBase, forceProxy); // 代理转发目标：自定义地址优先，回落源默认 base
  const baseUrl = resolveBaseUrl(override, proxyUpstream, defaultBase);

  // 统一声明式适配器：所有源都是 mode: "declarative"（config.endpoints/params/mapping 声明数据面）。
  // 声明式源带自己的默认端点，mode 字段仅为语义标注，不再区分适配器类型。
  registry.register(new DeclarativeSource({
    id: s.id,
    label: s.label,
    baseUrl,
    defaultBase,
    proxyUpstream,
    config: s.config || {},
    timeoutMs,
  }));
}

/** 从运行时配置注册视频源（loadConfig 之后调用）。
 *  源定义缺省时回退到内置默认（runtimeConfig 的 declarative 沐凡源），保证无 config.json 也能跑。
 *  注册完 config 源后并入「本机自定义源」（sourcePrefs localStorage，规则工坊「保存到本机」产物）：
 *  同 id 时后注册者覆盖（Map.set 语义），刷新页面即生效、无需落 sources.d/。 */
export async function initSources(runtime) {
  const cfg = runtime || CONFIG.runtime;
  const sources = cfg?.sources?.length ? cfg.sources : getRuntime().sources;
  const timeout = cfg?.request?.timeout_ms;

  for (const s of sources) registerSource(s, timeout);
  for (const s of listCustomSources()) registerSource(s, timeout);

  // 首个注册者默认激活
  if (!registry.active() && registry.list().length > 0) {
    registry.use(registry.list()[0].id);
  }
}

/** 前端自定义某源的 baseUrl + 是否启用代理，并立即应用到已注册适配器。
 *  proxy=true + 有上游（自定义地址或源默认 base）→ 走服务器代理（发同源根 + ?proxy_upstream=）。
 *  proxy=false / 无上游 → 直连自定义地址（或默认地址）。 */
export function setSourceBase(id, url, proxy) {
  const val = setBaseUrl(id, url);                     // 持久化 baseUrl
  if (typeof proxy === "boolean") setProxy(id, proxy); // 持久化代理开关
  const a = registry.get(id);
  if (a && typeof a.setBase === "function") {
    const useProxy = (typeof proxy === "boolean" ? proxy : getProxy(id));
    const up = proxyUpstreamFor(val || a.defaultBase, useProxy);
    // 同步代理上游：proxy + 有上游 → 明文 ?proxy_upstream= 交给 server 代理
    if (typeof a.setProxyUpstream === "function") a.setProxyUpstream(up);
    // proxy 模式 resolved="" → setBase("") 落同源根（window.location）；非 proxy → 直连地址
    a.setBase(resolveBaseUrl(val, up, a.defaultBase) || "");
  }
  return val;
}

export { registry, activeSource, listSources, SourceRegistry };
export { getBaseUrl, getProxy } from "../sourcePrefs.js"; // 供 UI 回显当前覆盖值与代理开关
export { DeclarativeSource } from "./declarativeSource.js";
export { normalize, QUEUE_ITEM_SCHEMA } from "./schema.js";