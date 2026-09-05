// config.js · 所有阈值集中配置（ADR 要求：代码不写死，上线走配置中心调优）
// 对应文档：v1.1 第 7.4 节「三」—— 阈值全部可配置。

export const CONFIG = {
  // 数据源/代理运行时配置（来自 config.json，由 runtimeConfig.js 注入；未注入前为 null，走下方内置默认）
  runtime: null,
  // —— 8.2 预加载 (ADR-9) —— 触发阈值按剩余时长计算
  preload: {
    triggerRemainingSec: 30,     // min(30s, duration*50%) 的上限
    triggerRatio: 0.5,           // duration × 50%
    minSinceStartSec: 5,         // 距开播 ≥ 5s，避免 seek 抖动
    defaultLevel: "L2",          // 默认目标等级（起播零缓冲）
    wifiMaxLevel: "L3",          // Wi-Fi 允许升 L3
    cellularCapLevel: "L2",      // 蜂窝封顶 L2
    saveDataCapLevel: "L1",      // 省流模式封顶 L1
    preloadBytesL2: 300 * 1024,  // L2：起播头部分片体量（模拟）
    preloadBytesL3: 6 * 1024 * 1024, // L3：追加 30~60s 正片（模拟）
    enabled: true,
  },

  // —— 8.1 缝合快照持久化 (ADR-8) ——
  snapshot: {
    schemaVersion: 1,
    expireMs: 7 * 24 * 3600 * 1000, // 7 天过期
    storageKey: "player.stitch.snapshot.v1",
  },

  // —— 8.4 主队列刷新 (ADR-11) ——
  refresh: {
    cooldownMs: 30 * 60 * 1000,   // 30 分钟冷却
    pendingTtlMs: 24 * 3600 * 1000, // 缝合态挂起 TTL 24h
    staleSessionMs: 2 * 3600 * 1000, // 会话 ≥ 2h
    stalePointerAdvance: 20,     // 且指针推进 ≥ 20
    reenterMs: 30 * 60 * 1000,   // 场景重入：离开 ≥ 30 分钟
  },

  // —— 合集加载重试（_loadCollection：失败重试 maxRetry 次，间隔 retryMs，超限降级 Fallback）——
  api: {
    maxRetry: 2,
    retryMs: 1000,
  },

  // —— 8.5 埋点上报 (ADR-12) ——
  tracker: {
    batchSize: 20,
    flushIntervalMs: 30 * 1000,
    retryLimit: 3,
    bufferCap: 500,
  },
  // 数据源已运行时化：源定义在 config.json 的 sources[]（声明式），无阈值需在此收敛
};

// 预加载等级排序（用于网络封顶比较）
export const LEVEL_ORDER = { L0: 0, L1: 1, L2: 2, L3: 3 };
