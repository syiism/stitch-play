// schema.js · 视频源兼容层：归一化「队列元素」标准结构
//
// 兼容层目标：让「本地示例源 / 远程 REST 源 / 第三方平台源」都能接入播放器，
// 调度内核（状态机 / 预加载 / UI / 播放器）只认这一种规范结构，不关心各源原始字段差异。
//
// 新增一个视频源，只需：① 实现 adapter.js 的适配器契约；② 用 normalize() 把原始字段映射成
// 下面的 QUEUE_ITEM；③ 在 sources/index.js 注册。内核零改动即可切换。

// 规范 QueueItem（所有适配器返回的元素都必须是它）
export const QUEUE_ITEM_SCHEMA = {
  videoId:      "string",         // 稳定 id（合集内 / 全局唯一）
  title:        "string",         // 展示标题
  src:          "string",         // 可播放 URL（相对 / 绝对路径均可）
  poster:       "string|null",    // 封面图 URL
  duration:     "number|null",    // 时长（秒）；用于预加载触发阈值，缺省走默认阈值
  collectionId: "string|null",    // 所属合集 id；null = 独立短片
  episodeIndex: "number|null",    // 在所属合集内的下标
  category:     "string|null",    // 源侧分类（如「短剧」「漫剧」），用于 UI 区分展示
  source:       "string",         // 提供该元素的适配器 id（溯源）
  raw:          "object",          // 源原始 payload（调试 / 源特定字段透传，不参与内核逻辑）
};

// 把任意「原始元素」按 mapping 映射成规范 QueueItem。
// mapping 形如 { videoId:"clipId", title:"displayName", src:"playUrl", duration:"durSec" }，
// 未列出的字段尝试同名透传，仍缺则取默认值。
export function normalize(raw, mapping, sourceId) {
  const m = mapping || {};
  const pick = (canon, dflt) => {
    const srcKey = m[canon];
    if (srcKey != null && raw[srcKey] !== undefined) return raw[srcKey];
    if (raw[canon] !== undefined) return raw[canon];
    return dflt;
  };
  const vid = String(pick("videoId", raw.id ?? raw.vid ?? ""));
  const dur = pick("duration", raw.duration ?? raw.dur ?? raw.durSec ?? null);
  return {
    videoId:      vid,
    title:        String(pick("title", raw.name ?? raw.title ?? vid ?? "未命名")),
    src:          String(pick("src", raw.src ?? raw.url ?? raw.playUrl ?? "")),
    poster:       pick("poster", raw.poster ?? raw.cover ?? null),
    duration:     (typeof dur === "number" && !Number.isNaN(dur)) ? dur : null,
    collectionId: pick("collectionId", raw.collectionId ?? raw.playlistId ?? raw.seriesId ?? null),
    episodeIndex: pick("episodeIndex", raw.episodeIndex ?? raw.ep ?? raw.index ?? null),
    category:     pick("category", raw.category ?? raw.kind ?? null),
    source:       sourceId,
    raw,
  };
}
