// tracker.js · 埋点订阅者（重构版：缝合态融入合集队列）
//
// 变更：STITCH_ENTERED/EXITED 事件映射到 COLLECTION_EXITED 的 exitType

import { EVENT } from "./eventBus.js";
import { CONFIG } from "./config.js";

export class Tracker {
  constructor(bus, { sessionId, networkType = "wifi", onFlush } = {}) {
    this.bus = bus;
    this.sessionId = sessionId || ("sess-" + Math.random().toString(36).slice(2, 8));
    this.networkType = networkType;
    this.onFlush = onFlush || (() => {});
    this.buffer = [];
    this.retry = 0;

    this.m = {
      collectionEnter: 0,
      collectionAutoFinish: 0,
      exitedEnter: 0,          // 退出合集（进入已退出态）
      exitedExitWithTail: 0,   // 已退出合集被恢复（沿尾巴续播）
      exitedExit: 0,            // 已退出合集被完全脱离
      fallback: 0,
      tailConsumedSum: 0,
    };
    this._collStart = 0;
    this._exitedStart = 0;

    this._subscribe();
    this._timer = setInterval(() => this.flush(), CONFIG.tracker.flushIntervalMs);
  }

  _subscribe() {
    this.bus.on(EVENT.COLLECTION_ENTERED, (p) => {
      this.m.collectionEnter++;
      this._collStart = Date.now();
      this._log("collection_enter", {
        entrySource: p.pointerSource,
        collectionId: p.collectionId,
        startEpisode: p.startEpisodeIndex,
      });
    });
    this.bus.on(EVENT.COLLECTION_EXITED, (p) => {
      if (p.exitType === "exitMarked" || p.exitType === "recovered") {
        // 进入已退出态（= 原 stitch_enter）
        this.m.exitedEnter++;
        this._exitedStart = Date.now();
        this._log("exited_enter", {
          collectionId: p.collectionId,
          playedEpisodes: p.playedEpisodes,
        });
      } else if (p.exitType === "autoFinish") {
        this.m.collectionAutoFinish++;
        const watchDuration = this._collStart ? Date.now() - this._collStart : 0;
        this._log("collection_exit", { exitType: "autoFinish", watchDuration, playedEpisodes: p.playedEpisodes });
      } else if (p.exitType === "consumeMainItem") {
        // 已退出合集被完全脱离
        this.m.exitedExit++;
        this.m.tailConsumedSum += p.playedEpisodes || 0;
        const exitedDuration = this._exitedStart ? Date.now() - this._exitedStart : 0;
        this._log("exited_exit", { exitType: "consumeMainItem", exitedDuration });
      }
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
      ...extra,
    };
    this.buffer.push(evt);
    if (this.buffer.length > CONFIG.tracker.bufferCap) this.buffer.shift();
    if (this.buffer.length >= CONFIG.tracker.batchSize) this.flush();
  }

  async flush() {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await this._report(batch);
      this.retry = 0;
      this.onFlush(batch, this.metrics());
    } catch (e) {
      if (this.retry < CONFIG.tracker.retryLimit) {
        this.retry++;
        this.buffer = batch.concat(this.buffer);
        setTimeout(() => this.flush(), 2 ** this.retry * 1000);
      } else {
        this.buffer = [];
      }
    }
  }

  _report(batch) {
    return Promise.resolve();
  }

  metrics() {
    return {
      collectionFinishRate: this.m.collectionEnter ? this.m.collectionAutoFinish / this.m.collectionEnter : 0,
      stitchKeepRate: this.m.exitedEnter ? this.m.exitedExitWithTail / this.m.exitedEnter : 0,
      fallbackRate: (this.m.collectionEnter + this.m.fallback)
        ? this.m.fallback / (this.m.collectionEnter + this.m.fallback) : 0,
      tailDepth: this.m.exitedEnter ? this.m.tailConsumedSum / this.m.exitedEnter : 0,
      collectionEnter: this.m.collectionEnter,
      collectionAutoFinish: this.m.collectionAutoFinish,
      stitchEnter: this.m.exitedEnter,
      stitchExit: this.m.exitedExit,
      fallback: this.m.fallback,
      tailConsumedSum: this.m.tailConsumedSum,
    };
  }

  dispose() { clearInterval(this._timer); }
}
