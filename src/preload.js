// preload.js · 预加载仲裁器（ADR-9 订阅者，零侵入调度内核）
//
// 唯一依据 = 调度模型的确定性：状态迁移即重新裁决目标，单槽位（至多一个活动任务）。
// 等级由网络环境封顶（L0-L3）。触发按剩余时长（非百分比）。

import { EVENT } from "./eventBus.js";
import { STATE } from "./queueModel.js";
import { CONFIG, LEVEL_ORDER } from "./config.js";
import { activeSource } from "./sources/index.js";

export class PreloadArbiter {
  constructor(bus, fsm) {
    this.bus = bus;
    this.fsm = fsm; // 只读 model / state
    this.current = null;            // 当前预载任务
    this.cache = new Set();         // 去重键 videoId+level
    this._startedAt = 0;

    // 订阅状态迁移与关键输出事件 → 重裁决
    bus.on(EVENT.STATE_CHANGED, () => this._recompute());
    bus.on(EVENT.ITEM_CONSUMED, () => this._recompute());
    bus.on(EVENT.COLLECTION_ENTERED, () => this._recompute());
    bus.on(EVENT.STITCH_TAIL_ADVANCED, () => this._recompute());
    bus.on(EVENT.MAIN_QUEUE_REPLACED, () => this._recompute());
  }

  // —— 3.2 状态-目标矩阵 ——
  _targetFor(state) {
    const m = this.fsm.model;
    const netCap = this._netCap();
    const mk = (videoId, level) => ({ videoId, level: this._cap(level, netCap) });
    switch (state) {
      case STATE.MAIN_QUEUE:
        return m.mainCurrent() ? mk(m.mainCurrent().videoId, "L2") : null; // 当前元素（指针=当前元素）；合集末集播放见下
      case STATE.LOAD_COLLECTION:
        return null; // 下一首未定，任何预载都是投机（L0）
      case STATE.COLLECTION_QUEUE: {
        if (m.collectionIsLast()) {
          // 合集末集播放中 → 主队列 pointer 项（自动退出需无缝衔接）
          return m.mainCurrent() ? mk(m.mainCurrent().videoId, "L2") : null;
        }
        const nxt = m.collectionQueue?.items[m.collectionQueue.pointer + 1];
        return nxt ? mk(nxt.videoId, "L2") : null;
      }
      case STATE.STITCH: {
        if (m.stitchTailLength() === 0) {
          return m.mainCurrent() ? mk(m.mainCurrent().videoId, "L2") : null; // 尾巴将空 → 主队列
        }
        const tailNext = m.stitch.remainingTail[0];
        return tailNext ? mk(tailNext.videoId, "L2") : null; // 尾巴下一集
      }
      default:
        return null;
    }
  }

  _netCap() {
    if (this.fsm.networkLevel === "cellular") return "L2";
    if (this.fsm.networkLevel === "saveData") return "L1";
    return "L3"; // wifi
  }
  _cap(level, netCap) {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[netCap] ? level : netCap;
  }

  _recompute() {
    // 旧任务无条件作废（状态迁移即确定性失效）
    if (this.current && this.current.state !== "done") {
      this.current.state = "cancelled";
      this.bus.emit(EVENT.PRELOAD_STAGE, { videoId: this.current.videoId, level: this.current.level, result: "cancelled" });
    }
    const t = this._targetFor(this.fsm.state);
    if (!t || !CONFIG.preload.enabled) { this.current = null; return; }
    const video = activeSource().getVideoMeta(t.videoId);
    if (!video || !video.src) { this.current = null; return; } // 懒解析源（如 mufan）未取流前置空
    // 触发阈值：min(30s, duration×50%)；duration 缺失时回退到默认阈值
    const dur = (typeof video.duration === "number" && video.duration > 0) ? video.duration : 0;
    const trigger = dur > 0
      ? Math.min(CONFIG.preload.triggerRemainingSec, dur * CONFIG.preload.triggerRatio)
      : CONFIG.preload.triggerRemainingSec;
    this.current = { videoId: t.videoId, level: t.level, triggerThreshold: trigger, state: "idle", src: video.src };
    // 去重命中
    const key = `${t.videoId}@${t.level}`;
    if (this.cache.has(key)) {
      this.current.state = "done";
      this.bus.emit(EVENT.PRELOAD_STAGE, { videoId: t.videoId, level: t.level, result: "hit" });
    }
  }

  // 播放进度 → 到达阈值才真正发起网络请求
  onProgress(remainingSec, sinceStartSec) {
    const c = this.current;
    if (!c || c.state !== "idle") return;
    if (sinceStartSec < CONFIG.preload.minSinceStartSec) return; // 避免 seek 抖动
    if (remainingSec <= c.triggerThreshold) this._start(c);
  }

  async _start(task) {
    task.state = "running";
    this._startedAt = Date.now();
    const bytes = task.level === "L3" ? CONFIG.preload.preloadBytesL3 : CONFIG.preload.preloadBytesL2;
    const key = `${task.videoId}@${task.level}`;
    try {
      // 真实 Range 请求预热缓存（L2 起播头部分片；L3 Wi-Fi 追加正片）
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
