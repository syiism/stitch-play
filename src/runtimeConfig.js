// runtimeConfig.js · 前端加载数据源/代理配置（不含真实上游地址）
//
// 单一真相源：/config.json（与 tools/server.py 读同一文件，代理与源定义一致）。
//   浏览器统一经同源 fetch('/config.json') 读取 → 注入 CONFIG.runtime。
//   安全：所有源 base 一律留空（仓库/下发配置不携带上游地址），
//   真实地址由前端 localStorage 偏好按源注入（代理型上游走 ?proxy_upstream= 转发）。
//   读取失败（如用裸 http.server，或文件缺失）时回退内置默认，页面仍可用。
//
// 用法：await loadConfig()（boot 时先于构建 FSM / 注册源调用）。

import { CONFIG } from "./config.js";

// 内置默认：无 config.json 时的回退源（与 tools/server.py 的 BUILTIN_CONFIG、sources.d/
// 的沐凡源保持一致）。全部为声明式源（mode: "declarative"）；base 留空 = 请求发往同源根路径
// （配合前端「启用代理」开关 + 自定义 http 上游时，由 server 按 ?proxy_upstream= 参数代为同源转发）。
const DEFAULT = {
  sources: [
    {
      id: "mufan-short",
      label: "沐凡 · 短剧",
      category: "short",
      mode: "declarative",
      base: "",
      config: {
        endpoints: {
          discover: "/api/bookmall/cell/change",
          search: "/api/search",
          directory: "/api/directory",
          video: "/api/video",
        },
        params: {
          discover: { genre_tab: 4, algo_type: 101 },
          search: { tab_type: 11 },
          directory: {},
          video: { type: "json", proxy: 1 },
        },
        mapping: {
          items: "$.book_info",
          videoId: "drama-$.series_id",
          title: "$.title",
          poster: "$.cover",
          collectionId: "col-$.series_id",
          category: "短剧",
        },
        collectionItemsPath: "item_data_list",
      },
    },
    {
      id: "mufan-manju",
      label: "沐凡 · 漫剧",
      category: "manju",
      mode: "declarative",
      base: "",
      config: {
        endpoints: {
          discover: "/api/bookmall/cell/change",
          search: "/api/search",
          directory: "/api/directory",
          video: "/api/video",
        },
        params: {
          discover: { genre_tab: 5, algo_type: 101 },
          search: { tab_type: 19 },
          directory: {},
          video: { type: "json", proxy: 1 },
        },
        mapping: {
          items: "$.book_info",
          videoId: "drama-$.series_id",
          title: "$.title",
          poster: "$.cover",
          collectionId: "col-$.series_id",
          category: "漫剧",
        },
        collectionItemsPath: "item_data_list",
      },
    },
  ],
  request: { timeout_ms: 45000 },
};

/** 从运行时配置取「视频源」相关子节，缺失时回退内置默认 */
export function getRuntime() {
  return CONFIG.runtime || DEFAULT;
}

/** 应用运行时配置：剥离 upstream、更新 CONFIG.runtime。 */
function _apply(cfg, source) {
  // 无论服务端是否已剥离，客户端一律丢弃 upstream —— 上游地址绝不进入前端运行时
  for (const p of (cfg.proxies || [])) delete p.upstream;
  CONFIG.runtime = cfg;
  console.info(`[Config] ${source} 加载成功，源数：`, cfg.sources.length);
  return cfg;
}

export async function loadConfig() {
  // 前端配置统一只从 /config.json 获取（server.py 经该路由剥离 upstream 后下发，代理/源定义即唯一真相源）。
  // 获取失败（404 视作「未提供」，或其它异常）时回退内置默认，页面仍可用。
  const url = "/config.json";
  try {
    const resp = await fetch(url, { cache: "no-store" });
    if (resp.status === 404) {
      console.info(`[Config] ${url} 未提供，使用内置默认`);
      return getRuntime();
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const cfg = await resp.json();
    if (cfg && Array.isArray(cfg.sources)) return _apply(cfg, url);
    throw new Error("配置缺少 sources");
  } catch (e) {
    console.warn(`[Config] ${url} 加载失败：`, e.message);
  }
  return getRuntime();
}
