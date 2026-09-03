// player.js · 播放器控制器（DOM <video> ↔ 状态机 桥接）
//
// 角色：把 <video> 的原始事实（ended / error / progress）作为「输入事件」送进状态机；
//       订阅 StateChanged 等输出事件，按 model.currentVideoId() 加载并播放——播放器只写 DOM，不写队列状态。

import { EVENT } from "./eventBus.js";
import { activeSource } from "./sources/index.js";

export class PlayerController {
  constructor(videoEl, fsm, preload) {
    this.video = videoEl;
    this.fsm = fsm;
    this.preload = preload;
    this._loadedVideoId = null;
    this._startTs = 0;
    this._resumePending = false; // 加载-续播定位期间挂起进度回写（防 timeupdate(0) 覆盖元素记录）

    // —— 声音解锁（浏览器自动播放策略：有声自动播放需用户手势）——
    // 起播默认静音；用户与页面发生首次交互（点按钮/卡片/按键）后自动取消静音。
    this._userMuted = true;
    this._userVolume = 1;      // 用户音量等级（0–1），与静音状态独立（切源/切集保留）
    this._audioUnlocked = false;
    this.onMuteChange = null;  // UI 回调：静音状态变化（渲染声音开关）
    this.onVolumeChange = null; // UI 回调：音量等级变化（渲染音量滑块）
    const unlockOnce = () => {
      this.unlockAudio();
      document.removeEventListener("pointerdown", unlockOnce, true);
      document.removeEventListener("keydown", unlockOnce, true);
    };
    document.addEventListener("pointerdown", unlockOnce, true);
    document.addEventListener("keydown", unlockOnce, true);
    this.video.addEventListener("volumechange", () => this.onMuteChange?.(this.video.muted));

    // 订阅状态迁移 → 按需加载当前视频
    fsm.bus.on(EVENT.STATE_CHANGED, () => this._sync());
    fsm.bus.on(EVENT.MAIN_QUEUE_REPLACED, () => this._sync());
    fsm.bus.on(EVENT.COLLECTION_ENTERED, (p) => { if (p.pointerSource === "tailResume" || p.pointerSource === "reenter") this._sync(); });

    // 播放器原始输入 → 状态机
    this.video.addEventListener("ended", () => this.fsm.playbackEnded());
    this.video.addEventListener("error", () => console.error("[Player] video error", this.video.error));
    this.video.addEventListener("timeupdate", () => this._onTime());
  }

  /** 首次用户交互后解除静音（此时浏览器允许有声播放） */
  unlockAudio() {
    if (this._audioUnlocked) return;
    this._audioUnlocked = true;
    this._userMuted = false;
    this.video.muted = false;
    if (this.video.paused && this.video.src) {
      this.video.play().catch(() => {/* 保持暂停不报错 */});
    }
  }

  /** 显式声音开关，返回切换后是否「有声」 */
  toggleMute() {
    if (!this._audioUnlocked) {
      this.unlockAudio();          // 第一次点它 = 解锁（开声）
      return !this.video.muted;
    }
    this._userMuted = !this._userMuted;
    this.video.muted = this._userMuted;
    return !this._userMuted;
  }

  /** 设置音量等级（0–1）。音量 >0 时自动取消静音；返回实际生效等级（已 clamp）。 */
  setVolume(level) {
    this._userVolume = Math.min(1, Math.max(0, Number(level) || 0));
    this.video.volume = this._userVolume;
    if (this.video.muted && this._userVolume > 0) {
      this.video.muted = false;
      this._userMuted = false;
    }
    this.onVolumeChange?.(this._userVolume, this.video.muted);
    return this._userVolume;
  }
  /** 当前音量等级（0–1） */
  getVolume() {
    return this._userVolume;
  }

  /** 初始加载（boot 时调用一次）。
   *  仅在尚未加载任何视频时才强制加载——冷恢复场景 recoverCollection 的 StateChanged
   *  已触发过一次 load，这里再 force 会产生第二次 _applySrc，两次加载之间的
   *  canplay→play→timeupdate 窗口会把元素/缝合上下文的续播进度覆盖为从头的小值。 */
  init() { this._sync(this._loadedVideoId === null); }

  _sync(force = false) {
    const vid = this.fsm.model.currentVideoId();
    if (!vid) return;
    if (vid === this._loadedVideoId && !force) return; // 同一视频，不重载（保持无缝）
    this.load(vid);
  }

  load(videoId) {
    const source = activeSource();
    const v = source.getVideoMeta(videoId);
    if (!v) return;
    this._loadedVideoId = videoId;
    // 切视频从这一刻起挂起进度回写：懒解析期间旧视频可能仍在播，其 timeupdate 的
    // 旧进度若继续喂内核，会写进「当前元素」（指针已指向新视频）——新视频
    // 加载后的续播定位就会继承上一个视频的进度（v1.0 §六 元素状态完整性）
    this._resumePending = true;
    if (v.src) { this._applySrc(v.src); return; }
    // 兼容层懒解析（如 mufan：起播时才经 /api/video 取流）
    if (typeof source.resolveSrc !== "function") { this._resumePending = false; return; }
    this._resolveToken = (this._resolveToken || 0) + 1;
    const token = this._resolveToken;
    this.video.removeAttribute("src"); // 解析期间清空，避免播放旧片
    this.video.pause(); // 并真正停播：仅移除属性不会中断当前播放，旧片继续播会持续
    // 产生 timeupdate/ended（ended 会再推指针），且旧进度会被记到新元素头上
    source.resolveSrc(videoId).then((url) => {
      if (token !== this._resolveToken) return; // 期间已切其他视频，丢弃（新流程负责 settle）
      if (!url) {
        console.error("[Player] 取流失败:", videoId);
        this._resumePending = false;
        return;
      }
      this._applySrc(url);
    }).catch((e) => {
      console.error("[Player] resolveSrc 异常:", e);
      if (token === this._resolveToken) this._resumePending = false;
    });
  }

  _applySrc(src) {
    // 加载期间挂起进度回写：video.load() 重置播放位置会先排一个 timeupdate(0)，
    // 若不拦，会把元素已记录的续播进度覆盖为 0（v1.0 §六 元素状态的完整性）
    this._resumePending = true;
    this.video.src = src;
    this.video.muted = this._userMuted; // 未解锁前静音；已解锁则尊重用户选择
    this.video.volume = this._userVolume; // 切源/切集保留用户音量等级
    const settle = () => { this._resumePending = false; };
    // v1.0 §六：元素保留了播放状态 → 元数据就绪后从记录进度续播（回看/选集/冷恢复）
    this.video.addEventListener("loadedmetadata", () => { this._seekToResume(); settle(); }, { once: true });
    this.video.load();
    const tryPlay = () => { settle(); this.video.play().catch(() => {/* 等待用户手势 */}); };
    if (this.video.readyState >= 2) tryPlay();
    else this.video.addEventListener("canplay", tryPlay, { once: true });
    this.video.addEventListener("error", settle, { once: true });
    this._startTs = 0;
  }

  /** 续播定位：读内核记录的元素进度，>3s 且未播完才跳（避免为几秒进度整段回跳） */
  _seekToResume() {
    const pos = this.fsm.getResumePosition(this._loadedVideoId);
    if (!pos) return;
    const d = this.video.duration;
    if (d && pos >= d - 1) return;
    try { this.video.currentTime = pos; console.info("[Player] 续播定位:", this._loadedVideoId, "→", pos.toFixed(1) + "s"); }
    catch (e) { /* metadata 未就绪等，忽略 */ }
  }

  _onTime() {
    const d = this.video.duration || 0;
    const c = this.video.currentTime || 0;
    const remaining = Math.max(0, d - c);
    const ratio = d ? c / d : 0;
    if (this._startTs === 0 && c > 0) this._startTs = c;
    const sinceStart = c; // 演示：直接用已播时长近似
    if (this._resumePending) return; // 加载-定位期间的时间戳是垃圾值，不喂内核
    // 喂给状态机（元素进度回写 + 缝合态懒恢复尾巴）与预加载仲裁器
    this.fsm.onProgress(c, d, remaining, ratio);
    this.preload.onProgress(remaining, sinceStart);
  }

  // —— 控件 ——
  togglePlay() {
    if (this.video.paused) this.video.play(); else this.video.pause();
  }
  isPaused() { return this.video.paused; }
  getCurrentVideoId() { return this._loadedVideoId; }
}
