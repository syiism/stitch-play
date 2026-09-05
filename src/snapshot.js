// snapshot.js · 已退出合集持久化（重构版：替代原缝合快照）
//
// 运行时内存态为唯一真相源；本地只持久化「不可再生的意图锚点」（<1KB）。
// 冷启动检测到快照 → 恢复已退出合集（标记 exited，尾巴懒恢复）。

import { EVENT } from "./eventBus.js";
import { CONFIG } from "./config.js";

const KEY = CONFIG.snapshot.storageKey;

export class SnapshotWriter {
  constructor(bus, fsm) {
    this.bus = bus;
    this.fsm = fsm;
    this._lastReplace = null;
    this._epIndex = -1;

    bus.on(EVENT.MAIN_QUEUE_REPLACED, (p) => {
      this._lastReplace = { anchorVideoId: p.anchorVideoId, replacedVideoId: p.replacedVideoId };
    });
    bus.on(EVENT.COLLECTION_EXITED, (p) => {
      // detach（单步退出，合集标记 exited 保留尾巴）/ exitMarked / recovered → 持久化退出锚点
      if (p.exitType === "detach" || p.exitType === "exitMarked" || p.exitType === "recovered") {
        this._epIndex = p.playedEpisodes - 1;
        this._write();
      } else if (p.exitType === "autoFinish" || p.exitType === "tailConsumed" || p.exitType === "consumeMainItem") {
        this._clear();
      }
    });
    bus.on(EVENT.COLLECTION_ENTERED, (p) => {
      // 重入同一合集 / 沿尾巴恢复（合集回到活跃态）→ 快照过期，清除
      if (p.pointerSource === "reenter" || p.pointerSource === "tailResume") {
        this._clear();
      }
    });

    const flush = () => this._write();
    document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
    window.addEventListener("pagehide", flush);
  }

  _write() {
    if (!this._lastReplace) return;
    const cq = this.fsm.model.collectionQueue;
    if (!cq?.exited) return;
    const snap = {
      schemaVersion: CONFIG.snapshot.schemaVersion,
      collectionId: cq.collectionId,
      currentEpisodeIndex: this._epIndex >= 0 ? this._epIndex : cq.pointer,
      currentVideoId: cq.items[cq.pointer]?.videoId,
      currentProgressSec: cq.items[cq.pointer]?.progressSec || 0,
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
