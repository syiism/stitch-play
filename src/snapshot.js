// snapshot.js · 缝合标记持久化（ADR-8 订阅者：锚点快照 + 懒恢复）
//
// 运行时内存态为唯一真相源；本地只持久化「不可再生的意图锚点」（<1KB）。
// 冷启动检测到快照 → 先重放主队列替换 + 开播当前集；合集尾巴不落盘，临需从接口重取（懒恢复）。

import { EVENT } from "./eventBus.js";
import { CONFIG } from "./config.js";

const KEY = CONFIG.snapshot.storageKey;

export class SnapshotWriter {
  constructor(bus, fsm) {
    this.bus = bus;
    this.fsm = fsm;
    this._lastReplace = null; // 最近一次 MainQueueReplaced 的锚点
    this._epIndex = -1;       // 当前集在合集中的绝对下标

    bus.on(EVENT.MAIN_QUEUE_REPLACED, (p) => {
      this._lastReplace = { anchorVideoId: p.anchorVideoId, replacedVideoId: p.replacedVideoId };
    });
    bus.on(EVENT.STITCH_ENTERED, (p) => {
      if (p.recovered) return;
      this._epIndex = p.episodeIndex;
      this._write();
    });
    bus.on(EVENT.STITCH_TAIL_ADVANCED, (p) => {
      if (p.ignored) return;       // 重入同一合集被忽略，不更新
      this._epIndex = (this._epIndex < 0 ? 0 : this._epIndex) + 1;
      this._write();
    });
    bus.on(EVENT.STITCH_EXITED, () => this._clear());

    // 缝合期间暂停 / 锁屏 / 短暂离开（v1.0 §五）：补写一次进度再挂起
    const flush = () => this._write();
    document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
    window.addEventListener("pagehide", flush);
  }

  _write() {
    if (!this._lastReplace) return;
    const st = this.fsm.model.stitch;
    if (!st.active) return;
    const snap = {
      schemaVersion: CONFIG.snapshot.schemaVersion,
      collectionId: st.collectionId,
      currentEpisodeIndex: this._epIndex,
      currentVideoId: st.currentVideoId,
      currentProgressSec: st.progressSec || 0, // 当前集播放进度（冷恢复续播用）
      mainAnchorVideoId: this._lastReplace.anchorVideoId,
      replacedVideoId: this._lastReplace.replacedVideoId,
      savedAt: Date.now(),
    };
    try { localStorage.setItem(KEY, JSON.stringify(snap)); }
    catch (e) { console.warn("[Snapshot] 写入失败", e); }
  }

  _clear() {
    try { localStorage.removeItem(KEY); } catch (e) {}
    this._lastReplace = null;
    this._epIndex = -1;
  }

  /** 冷启动读取并校验（schemaVersion / 7 天过期） */
  static read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s.schemaVersion !== CONFIG.snapshot.schemaVersion) { localStorage.removeItem(KEY); return null; }
      if (Date.now() - s.savedAt > CONFIG.snapshot.expireMs) { localStorage.removeItem(KEY); return null; }
      return s;
    } catch (e) { return null; }
  }

  static clear() { try { localStorage.removeItem(KEY); } catch (e) {} }
}
