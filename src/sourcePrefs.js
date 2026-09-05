// sourcePrefs.js · 视频源运行偏好（前端自定义，localStorage 持久化）
//
// 允许用户在 UI 中为「某个数据源」覆盖 baseUrl（可填直链），
// 持久化到 localStorage；刷新后优先于 sources.d 声明的默认 base 生效。
//   覆盖为空/清除 = 回退到源默认 base（sources.d 的 base 字段，缺省同源根路径）。
// 说明：无 CORS 头的上游仍建议开「启用代理」走 ?proxy_upstream= 同源转发；
//       此处仅作为「前端自定义源地址」的便捷入口。

const KEY = "player.custom.sourceBase.v1";

function readRaw() {
  try {
    const raw = localStorage.getItem(KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === "object") ? obj : {};
  } catch {
    return {}; // 隐私模式 / 不可用：忽略
  }
}
function writeRaw(obj) {
  try { localStorage.setItem(KEY, JSON.stringify(obj || {})); } catch { /* 忽略 */ }
}

/** 读取某源的已存自定义 baseUrl；无则返回 null */
export function getBaseUrl(id) {
  const v = readRaw()[id];
  const u = v && typeof v.baseUrl === "string" ? v.baseUrl.trim() : "";
  return u || null;
}

/** 读写某源的覆盖 baseUrl。返回最终生效的 baseUrl（清除时返回 null）。 */
export function setBaseUrl(id, url) {
  const prefs = readRaw();
  const existing = prefs[id] || {};
  const u = String(url || "").trim().replace(/\/+$/, "");
  if (u) existing.baseUrl = u;
  else delete existing.baseUrl;
  _put(prefs, id, existing);
  return u || null;
}

/** 是否「强制走同源代理」：开启后填 http:// 绝对直链会改走 ?proxy_upstream=
 *  由本地 server 同源转发（相对路径继承页面协议），
 *  在 https 页面上规避「http 直链被浏览器混合内容策略拦截」。 */
export function getProxy(id) {
  const v = readRaw()[id];
  return !!(v && v.proxy === true);
}
export function setProxy(id, on) {
  const prefs = readRaw();
  const existing = prefs[id] || {};
  if (on) existing.proxy = true;
  else delete existing.proxy;
  _put(prefs, id, existing);
}

/** 统一落库：record 无 baseUrl 也无 proxy 时删掉整条（保持存储干净） */
function _put(prefs, id, record) {
  if (!record.baseUrl && !record.proxy && Object.keys(record).length === 0) delete prefs[id];
  else prefs[id] = record;
  writeRaw(prefs);
}