// tracker.js · 埋点订阅者（ADR-12，零侵入调度内核）
//
// 埋点是 QueueEvent 总线的纯订阅者：6 个埋点事件复用事件目录 + 补会话上下文；
// 4 个北极星指标本地计算；本地缓冲双阈值（满 20 条 / 30s）批量上报，可丢弃永不阻塞主链路。

import { EVENT } from "./eventBus.js";
import { CONFIG } from "./config.js";

export class Tracker {
  constructor(bus, { sessionId, networkType = "wifi", onFlush } = {}) {
    this.bus = bus;
    this.sessionId = sessionId || ("sess-" + Math.random().toString(36).slice(2, 8));
    this.networkType = networkType;
    this.onFlush = onFlush || (() => {});
    this.buffer = [];      // FIFO，上限 500
    this.retry = 0;

    // 北极星指标累计
    this.m = {
      collectionEnter: 0,
      collectionAutoFinish: 0,
      stitchEnter: 0,
      stitchExitWithTail: 0,   // tailConsumed >= 1
      stitchExit: 0,
      fallback: 0,
      tailConsumedSum: 0,
    };
    // 时长上下文
    this._collStart = 0;
    this._stitchStart = 0;

    this._subscribe();
    this._timer = setInterval(() => this.flush(), CONFIG.tracker.flushIntervalMs);
  }

  _subscribe() {
    this.bus.on(EVENT.COLLECTION_ENTERED, (p) => {
      this.m.collectionEnter++;
      this._collStart = Date.now();
      this._log("collection_enter", { entrySource: p.pointerSource === "history" ? "playAll" : "deepLink", collectionId: p.collectionId });
    });
    this.bus.on(EVENT.COLLECTION_EXITED, (p) => {
      const watchDuration = this._collStart ? Date.now() - this._collStart : 0;
      if (p.exitType === "autoFinish") this.m.collectionAutoFinish++;
      this._log("collection_exit", { exitType: p.exitType, watchDuration, playedEpisodes: p.playedEpisodes });
    });
    this.bus.on(EVENT.STITCH_ENTERED, (p) => {
      this.m.stitchEnter++;
      this._stitchStart = Date.now();
      this._log("stitch_enter", { collectionId: p.collectionId, episodeIndex: p.episodeIndex, tailLength: p.tailLength });
    });
    this.bus.on(EVENT.STITCH_EXITED, (p) => {
      this.m.stitchExit++;
      if (p.tailConsumed >= 1) this.m.stitchExitWithTail++;
      this.m.tailConsumedSum += p.tailConsumed;
      const stitchDuration = this._stitchStart ? Date.now() - this._stitchStart : 0;
      this._log("stitch_exit", { exitType: p.exitType, stitchDuration, tailConsumed: p.tailConsumed });
    });
    this.bus.on(EVENT.FALLBACK_TRIGGERED, (p) => {
      this.m.fallback++;
      this._log("fallback_trigger", { scene: p.scene, reason: p.reason, retryCount: p.retryCount });
    });
    this.bus.on(EVENT.MAIN_QUEUE_REFRESHED, (p) => {
      this._log("queue_refresh", { trigger: p.trigger, anchorPreserved: !!p.anchorPreserved, pendingHeld: !!p.pendingHeld, dropped: !!p.dropped });
    });
  }

  _log(name, extra) {
    const evt = {
      name,
      ts: Date.now(),
      sessionId: this.sessionId,
      networkType: this.networkType,
      ...extra, // 仅 ID / 集序号 / 时间戳 / AB 分组，不含 UGC
    };
    this.buffer.push(evt);
    if (this.buffer.length > CONFIG.tracker.bufferCap) this.buffer.shift(); // 超限丢最旧
    if (this.buffer.length >= CONFIG.tracker.batchSize) this.flush();
  }

  async flush() {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      // 模拟上报（真实环境：上报至埋点网关）
      await this._report(batch);
      this.retry = 0;
      this.onFlush(batch, this.metrics());
    } catch (e) {
      if (this.retry < CONFIG.tracker.retryLimit) {
        this.retry++;
        this.buffer = batch.concat(this.buffer); // 放回，指数退避后重试
        setTimeout(() => this.flush(), 2 ** this.retry * 1000);
      } else {
        this.buffer = []; // 超限丢弃：埋点可丢，永不阻塞播放
      }
    }
  }

  _report(batch) {
    // 演示：仅输出，必然成功
    return Promise.resolve();
  }

  // —— 4 个北极星指标 ——
  metrics() {
    const denom = this.m.collectionEnter || 1;
    return {
      collectionFinishRate: this.m.collectionEnter ? this.m.collectionAutoFinish / this.m.collectionEnter : 0,
      stitchKeepRate: this.m.stitchEnter ? this.m.stitchExitWithTail / this.m.stitchEnter : 0,
      fallbackRate: (this.m.collectionEnter + this.m.fallback)
        ? this.m.fallback / (this.m.collectionEnter + this.m.fallback) : 0,
      tailDepth: this.m.stitchEnter ? this.m.tailConsumedSum / this.m.stitchEnter : 0,
      // 原始计数
      collectionEnter: this.m.collectionEnter,
      collectionAutoFinish: this.m.collectionAutoFinish,
      stitchEnter: this.m.stitchEnter,
      stitchExit: this.m.stitchExit,
      fallback: this.m.fallback,
      tailConsumedSum: this.m.tailConsumedSum,
    };
  }

  dispose() { clearInterval(this._timer); }
}
