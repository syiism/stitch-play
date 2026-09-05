// history.js · 播放记录（本地 localStorage 持久化）
//
// 记录「看过什么、看到哪」的可再生会话信息之外的浏览历史（与 snapshot 的「不可再生意图锚点」互补）：
//   - 订阅 PROGRESS_UPDATE（状态机节流广播）：进度经过时 upsert 一条播放记录
//   - 订阅 ITEM_CONSUMED（看完/消费）：标记 watched
// 记录粒度：每个「合集」只保留一条最新状态（换集/跳集时覆盖最新集与进度），
// 无合集的独立单集按 videoId 各留一条；保留最近 N 条，超出按 updatedAt 淘汰。
// 用途：竖屏「我的观看记录」抽屉、控制台历史面板、点击续播（进入合集 → 跳到对应集 → 从进度续播）。

import { EVENT } from "./eventBus.js";
import { CONFIG } from "./config.js";

const STORAGE_KEY = "player.history.v1";
const MAX_ENTRIES = CONFIG.history.maxEntries;

export class PlaybackHistory {
  constructor(bus, fsm) {
    this.fsm = fsm;
    this._cache = new Map(); // videoId -> record
    this._load();
    this._saveTimer = null;

    bus.on(EVENT.PROGRESS_UPDATE, (p) => {
      if (!p?.videoId) return;
      this.upsert({
        videoId: p.videoId,
        sourceId: p.sourceId || null,
        collectionId: p.collectionId || null,
        episodeIndex: p.episodeIndex ?? null,
        title: p.title || p.videoId,
        poster: p.poster || null,
        category: p.category || null,
        progressSec: p.progressSec || 0,
        durationSec: p.durationSec || null,
        ratio: p.ratio || 0,
        watched: !!p.watched,
      });
    });
    bus.on(EVENT.ITEM_CONSUMED, (p) => {
      if (!p?.videoId) return;
      const r = this.get(p.videoId);
      if (!r) return;
      r.watched = true;
      r.progressSec = r.durationSec || 0;
      r.updatedAt = Date.now();
      this._scheduleSave();
    });
    // 刷新页面前补写一次，避免丢最近进度
    window.addEventListener("pagehide", () => this._save());
  }

  // —— 读写 ——
  /** 记录 id：合集按合集标识去重（同合集只保留最新状态），无合集单集按 videoId。 */
  static _id(rec) { return rec.collectionId ? `c${rec.collectionId}` : rec.videoId; }

  upsert(rec) {
    const id = PlaybackHistory._id(rec);
    const prev = this._cache.get(id);
    this._cache.set(id, {
      id,
      videoId: rec.videoId,                       // 最新/当前集 id（续播、删改都按此定位）
      sourceId: rec.sourceId ?? prev?.sourceId ?? null,
      collectionId: rec.collectionId ?? prev?.collectionId ?? null,
      episodeIndex: rec.episodeIndex ?? prev?.episodeIndex ?? null,
      title: rec.title || prev?.title || rec.videoId,
      poster: rec.poster ?? prev?.poster ?? null,
      category: rec.category ?? prev?.category ?? null,
      progressSec: rec.progressSec || prev?.progressSec || 0,
      durationSec: rec.durationSec || prev?.durationSec || null,
      ratio: rec.ratio || prev?.ratio || 0,
      watched: !!rec.watched || !!prev?.watched,
      updatedAt: Date.now(),
    });
    this._scheduleSave();
  }

  /** 最近观看列表（按更新时间倒序） */
  list() {
    return Array.from(this._cache.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 支持续播的记录（有合集 + 进度>3s），用于历史续播 */
  resumable() {
    return this.list().filter((r) => r.collectionId && r.progressSec > 3);
  }

  /** 按 id 或 videoId 查找（跨源续播/宫格按 videoId 兜底时也兼容命中） */
  get(key) {
    if (this._cache.has(key)) return this._cache.get(key);
    for (const r of this._cache.values()) if (r.videoId === key) return r;
    return null;
  }
  /** 删除单条观看记录（按 id，兼容 videoId） */
  remove(key) {
    let k = key;
    if (!this._cache.has(k)) {
      const hit = [...this._cache.values()].find((r) => r.videoId === key);
      if (hit) k = hit.id; else return;
    }
    this._cache.delete(k);
    this._save();
  }
  clear() { this._cache.clear(); this._save(); }

  // —— 持久化 ——
  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this._save(); this._saveTimer = null; }, CONFIG.history.saveDebounceMs);
  }

  _save() {
    let list = this.list();
    if (list.length > MAX_ENTRIES) {
      // 按 id 淘汰：合集记录的键是 c<collectionId>（≠ videoId），按 videoId 删会删错/删不掉
      for (const r of list.slice(MAX_ENTRIES)) this._cache.delete(r.id);
      list = this.list();
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }
    catch (e) { console.warn("[History] 写入失败", e); }
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      for (const r of arr) {
        if (!r?.videoId) continue;
        const id = r.id || PlaybackHistory._id(r); // 兼容历史旧数据（无 id 字段）
        r.id = id;
        this._cache.set(id, r);
      }
    } catch (e) { console.warn("[History] 读取失败，已忽略", e); }
  }

  static list() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  static clear() { try { localStorage.removeItem(STORAGE_KEY); } catch (e) {} }
}

// 供「无内核实例」的静态入口（如独立指示器）使用
export const historyDb = {
  list: PlaybackHistory.list,
  clear: PlaybackHistory.clear,
};