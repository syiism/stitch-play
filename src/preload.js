// preload.js · 预加载仲裁器（重构版：缝合态融入合集队列）
//
// 变更：删除 STATE.STITCH 分支；MAIN_QUEUE 态检查已退出合集尾巴

import { EVENT } from "./eventBus.js";
import { STATE } from "./queueModel.js";
import { CONFIG, LEVEL_ORDER } from "./config.js";
import { activeSource } from "./sources/index.js";

export class PreloadArbiter {
  constructor(bus, fsm) {
    this.bus = bus;
    this.fsm = fsm;
    this.current = null;
    this.cache = new Set();
    this._startedAt = 0;

    bus.on(EVENT.STATE_CHANGED, () => this._recompute());
    bus.on(EVENT.ITEM_CONSUMED, () => this._recompute());
    bus.on(EVENT.COLLECTION_ENTERED, () => this._recompute());
    bus.on(EVENT.COLLECTION_EXITED, () => this._recompute());
    bus.on(EVENT.MAIN_QUEUE_REPLACED, () => this._recompute());
  }

  _targetFor(state) {
    const m = this.fsm.model;
    const netCap = this._netCap();
    const mk = (videoId, level) => ({ videoId, level: this._cap(level, netCap) });
    switch (state) {
      case STATE.MAIN_QUEUE: {
        const cq = m.collectionQueue;
        // 已退出合集 → 预加载尾巴下一集或主队列项
        if (cq?.exited) {
          const tailLen = m.exitedTailLength();
          if (tailLen > 0) {
            const nextItem = cq.items[cq.pointer + 1];
            return nextItem ? mk(nextItem.videoId, "L2") : null;
          }
          // 尾巴空 → 预加载主队列当前项
          return m.mainCurrent() ? mk(m.mainCurrent().videoId, "L2") : null;
        }
        return m.mainCurrent() ? mk(m.mainCurrent().videoId, "L2") : null;
      }
      case STATE.LOAD_COLLECTION:
        return null;
      case STATE.COLLECTION_QUEUE: {
        if (m.collectionIsLast()) {
          return m.mainCurrent() ? mk(m.mainCurrent().videoId, "L2") : null;
        }
        const nxt = m.collectionQueue?.items[m.collectionQueue.pointer + 1];
        return nxt ? mk(nxt.videoId, "L2") : null;
      }
      default:
        return null;
    }
  }

  _netCap() {
    if (this.fsm.networkLevel === "cellular") return "L2";
    if (this.fsm.networkLevel === "saveData") return "L1";
    return "L3";
  }
  _cap(level, netCap) {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[netCap] ? level : netCap;
  }

  _recompute() {
    if (this.current && this.current.state !== "done") {
      this.current.state = "cancelled";
      this.bus.emit(EVENT.PRELOAD_STAGE, { videoId: this.current.videoId, level: this.current.level, result: "cancelled" });
    }
    const t = this._targetFor(this.fsm.state);
    if (!t || !CONFIG.preload.enabled) { this.current = null; return; }
    const video = activeSource().getVideoMeta(t.videoId);
    if (!video || !video.src) { this.current = null; return; }
    const dur = (typeof video.duration === "number" && video.duration > 0) ? video.duration : 0;
    const trigger = dur > 0
      ? Math.min(CONFIG.preload.triggerRemainingSec, dur * CONFIG.preload.triggerRatio)
      : CONFIG.preload.triggerRemainingSec;
    this.current = { videoId: t.videoId, level: t.level, triggerThreshold: trigger, state: "idle", src: video.src };
    const key = `${t.videoId}@${t.level}`;
    if (this.cache.has(key)) {
      this.current.state = "done";
      this.bus.emit(EVENT.PRELOAD_STAGE, { videoId: t.videoId, level: t.level, result: "hit" });
    }
  }

  onProgress(remainingSec, sinceStartSec) {
    const c = this.current;
    if (!c || c.state !== "idle") return;
    if (sinceStartSec < CONFIG.preload.minSinceStartSec) return;
    if (remainingSec <= c.triggerThreshold) this._start(c);
  }

  /** 立即预取当前目标（调试面板「立即预取」按钮），无视剩余时长阈值。 */
  forceNow() {
    const c = this.current;
    if (!c) return false;
    if (c.state === "done") return false;
    if (c.state === "idle") this._start(c);
    return true;
  }

  async _start(task) {
    task.state = "running";
    this._startedAt = Date.now();
    const bytes = task.level === "L3" ? CONFIG.preload.preloadBytesL3 : CONFIG.preload.preloadBytesL2;
    const key = `${task.videoId}@${task.level}`;
    try {
      const resp = await fetch(task.src, { headers: { Range: `bytes=0-${bytes - 1}` } });
      await resp.arrayBuffer();
      task.state = "done";
      this.cache.add(key);
      this.bus.emit(EVENT.PRELOAD_STAGE, { videoId: task.videoId, level: task.level, result: "started" });
    } catch (e) {
      task.state = "failed";
      this.bus.emit(EVENT.PRELOAD_STAGE, { videoId: task.videoId, level: task.level, result: "failed" });
    }
  }
}
