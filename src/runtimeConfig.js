// runtimeConfig.js · 前端加载数据源/代理配置（不含真实上游地址）
//
// 单一真相源：config.json（与 tools/server.py 读同一文件，代理与源定义一致）。
//   浏览器经同源 fetch('./config.json') 读取 → 注入 CONFIG.runtime。
//   安全：前端/浏览器只拿到「代理前缀」（如 mf → "/mf"），真实上游地址仅留在服务端
//   （server.py 私有读取 + 下发时剥离 upstream），避免接口地址在客户端/页面源码泄露。
//   读取失败（如用裸 http.server，或文件缺失）时回退内置默认，页面仍可用。
//
// 用法：await loadConfig()（boot 时先于构建 FSM / 注册源调用）。

import { CONFIG } from "./config.js";

const DEFAULT = {
  // 前端只需代理前缀（相对路径源自前缀）；上游地址属服务端私密配置，前端不携带
  proxies: [{ prefix: "mf" }],
  sources: [
    { id: "mufan-short", label: "沐凡 · 短剧", category: "short", mode: "mufan", proxy: "mf" },
    { id: "mufan-manju", label: "沐凡 · 漫剧", category: "manju", mode: "mufan", proxy: "mf" },
  ],
  mufan_api: {
    discover: "/api/bookmall/cell/change",
    search: "/api/search",
    directory: "/api/directory",
    video: "/api/video",
  },
  tabs: {
    short: { genre_tab: 4, search_tab: 11 },
    manju: { genre_tab: 5, search_tab: 19 },
  },
  request: { timeout_ms: 45000 },
};

/** 代理前缀 → 浏览器访问的 baseUrl（同源相对路径：/mf） */
export function proxyBaseUrl(prefix) {
  const p = String(prefix || "").replace(/^\/+|\/+$/g, "");
  return p ? `/${p}` : "";
}

/** 从运行时配置取「视频源」相关子节，缺失时回退内置默认 */
export function getRuntime() {
  return CONFIG.runtime || DEFAULT;
}

export async function loadConfig() {
  try {
    const resp = await fetch("./config.json", { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const cfg = await resp.json();
    if (cfg && Array.isArray(cfg.sources)) {
      // 无论服务端是否已剥离，客户端一律丢弃 upstream —— 上游地址绝不进入前端运行时
      for (const p of (cfg.proxies || [])) delete p.upstream;
      CONFIG.runtime = cfg;
      // 服务端代理前缀 → 供适配器构造浏览器同源 baseUrl
      const proxies = cfg.proxies || [];
      CONFIG.runtime._proxyBase = {};
      for (const p of proxies) CONFIG.runtime._proxyBase[p.prefix] = proxyBaseUrl(p.prefix);
      console.info("[Config] config.json 加载成功，源数：", cfg.sources.length);
      return cfg;
    }
    throw new Error("配置缺少 sources");
  } catch (e) {
    console.warn("[Config] config.json 加载失败，使用内置默认：", e.message);
    return DEFAULT;
  }
}