// sourcePrefs.js · 视频源运行偏好（前端自定义，localStorage 持久化）
//
// 允许用户在 UI 中为「某个数据源」覆盖 baseUrl（可填直链 / 同源代理前缀），
// 持久化到 localStorage；刷新后优先于 config.json 的代理前缀生效。
//   覆盖为空/清除 = 回退到当前源默认代理前缀（如 /mf）。
// 说明：真实上游仍建议走同源代理；此处仅作为「前端自定义源地址」的便捷入口。

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
  if (!existing.baseUrl && Object.keys(existing).length === 0) delete prefs[id];
  else prefs[id] = existing;
  writeRaw(prefs);
  return u || null;
}