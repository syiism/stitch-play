// ui.js · UI 渲染订阅者（重构版：缝合态融入合集队列）
//
// 变更：删除 STATE.STITCH 引用、STITCH_* 事件订阅、renderStitch()；
// 已退出合集信息整合到合集面板显示。

import { EVENT } from "./eventBus.js";
import { STATE } from "./queueModel.js";
import { activeSource, listSources } from "./sources/index.js";

const STATE_LABEL = {
  [STATE.MAIN_QUEUE]: "主队列播放",
  [STATE.LOAD_COLLECTION]: "加载合集",
  [STATE.COLLECTION_QUEUE]: "合集队列播放",
  [STATE.FALLBACK]: "降级回主队列",
};

export class UI {
  constructor({ fsm, player, tracker, preload, snapshot, history, els }) {
    this.fsm = fsm; this.player = player; this.tracker = tracker;
    this.preload = preload; this.snapshot = snapshot; this.history = history || null; this.els = els;

    const b = fsm.bus;
    b.on(EVENT.STATE_CHANGED, (p) => { this.renderAll(); this.log("StateChanged", p); });
    b.on(EVENT.ITEM_CONSUMED, (p) => this.log("ItemConsumed", p));
    b.on(EVENT.COLLECTION_ENTERED, (p) => { this.renderCollection(); this.log("CollectionEntered", p); });
    b.on(EVENT.COLLECTION_EXITED, (p) => { this.renderCollection(); this.log("CollectionExited", p, p.exitType === "autoFinish" ? "ok" : p.exitType === "exitMarked" ? "warn" : ""); });
    b.on(EVENT.MAIN_QUEUE_REPLACED, (p) => { this.renderMain(); this.log("MainQueueReplaced", p, "replace"); });
    b.on(EVENT.MAIN_QUEUE_REFRESHED, (p) => { this.renderMain(); this.log("MainQueueRefreshed", p, p.dropped ? "warn" : "ok"); });
    b.on(EVENT.FALLBACK_TRIGGERED, (p) => { this.renderAll(); this.log("FallbackTriggered", p, "err"); this.toast(`降级：${p.scene}/${p.reason}`, "err"); });
    b.on(EVENT.PRELOAD_STAGE, (p) => { this.renderPreload(); this.log("PreloadStage", p, p.result === "started" ? "pre" : p.result === "failed" ? "err" : "pre"); });

    tracker.onFlush = (batch, metrics) => this.renderMetrics(metrics);

    this._bindControls();
    this._initFolds();
    this.populateSources();
    this.renderAll();
    this.renderMetrics(tracker.metrics());
  }

  _renderMute(on) {
    if (this.els.btnMute) {
      const ic = on ? "i-volume" : "i-mute";
      const label = on ? "声音开" : "声音关";
      this.els.btnMute.innerHTML = `<svg class="ic"><use href="#${ic}"/></svg><span>${label}</span>`;
      this.els.btnMute.title = on ? "开启声音" : "静音";
    }
  }

  populateSources() {
    if (!this.els.srcSel) return;
    const cur = this.fsm._source?.id;
    this.els.srcSel.innerHTML = listSources()
      .map((s) => `<option value="${s.id}" ${s.id === cur ? "selected" : ""}>${s.label}</option>`)
      .join("");
  }

  _initFolds() {
    const KEY = "player.ui.fold.v1";
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { saved = {}; }
    document.querySelectorAll(".card.foldable").forEach((card) => {
      const name = card.dataset.fold;
      const btn = card.querySelector(".fold-btn");
      const head = card.querySelector("h3");
      if (!name || !btn || !head) return;
      const apply = (collapsed) => {
        card.classList.toggle("collapsed", collapsed);
        btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
        btn.title = collapsed ? "展开" : "收起";
      };
      apply(saved[name] === true);
      head.addEventListener("click", () => {
        const collapsed = !card.classList.contains("collapsed");
        apply(collapsed);
        try {
          saved[name] = collapsed;
          localStorage.setItem(KEY, JSON.stringify(saved));
        } catch { }
      });
    });
  }

  _bindControls() {
    const e = this.els;
    e.btnPlay.onclick = () => this.player.togglePlay();
    this._renderMute(false);
    this.player.onMuteChange = (muted) => this._renderMute(!muted);
    e.btnMute.onclick = () => {
      const on = this.player.toggleMute();
      this._renderMute(on);
      this.toast(on ? "声音已开启" : "已静音", "ok");
    };
    e.btnEnter.onclick = () => {
      const cur = this.fsm.model.mainCurrent();
      if (cur) {
        const seed = this.fsm.model.mainQueue.seed[this.fsm.model.mainQueue.pointer];
        const colId = seed?.collectionId;
        // 已退出合集 → 重入
        if (this.fsm.model.collectionQueue?.exited) {
          this.fsm.enterCollection(this.fsm.model.collectionQueue.collectionId, "reenter");
          return;
        }
        if (colId) this.fsm.enterCollection(colId, "playAll");
      }
    };
    e.btnExit.onclick = () => this.fsm.exitCollection();
    e.btnSwitch.onclick = () => this.fsm.switchToNextMain();
    e.btnRefresh.onclick = () => this.fsm.requestRefresh("user-pull", { force: true });
    e.btnClearSnap.onclick = () => { this.snapshot.constructor.clear(); this.toast("已清空快照", "ok"); };
    e.btnRecover.onclick = () => this._tryRecover();
    e.netSel.onchange = () => {
      this.fsm.networkLevel = e.netSel.value;
      this.preload._recompute();
      this.renderPreload();
      this.toast(`网络：${e.netSel.value}`, "ok");
    };
    e.srcSel.onchange = () => {
      const id = e.srcSel.value;
      this.fsm.switchSource(id).then((r) => {
        const rg = r && typeof r === "object" ? r : { ok: !!r };
        if (rg.ok) {
          this.toast(
            rg.failed ? `已切换视频源：${activeSource().label}（主队列加载失败）` : `已切换视频源：${activeSource().label}`,
            rg.failed ? "warn" : "ok",
          );
        } else if (!rg.stale) {
          this.populateSources();
          this.toast(`未知视频源：${id}`, "err");
        }
      });
    };
    e.btnSearch.onclick = () => this._doSearch();
    e.searchInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") this._doSearch(); });
    e.mainList.onclick = (ev) => {
      const li = ev.target.closest("li[data-idx]");
      if (!li) return;
      const idx = parseInt(li.dataset.idx, 10);
      if (!Number.isInteger(idx)) return;
      const colId = li.dataset.col || "";
      if (!colId) {
        if (this.fsm.switchToMainIndex(idx)) this.toast(`切到第 ${idx + 1} 项`, "ok");
        return;
      }
      this.fsm.switchToMainIndex(idx);
      this.fsm.enterCollection(colId, "deepLink");
    };
    e.collList.onclick = (ev) => {
      const li = ev.target.closest("[data-idx]");
      if (!li) return;
      const idx = parseInt(li.dataset.idx, 10);
      if (this.fsm.jumpToEpisode(idx)) this.toast(`已跳到第 ${idx + 1} 集`, "ok");
      else this.toast("当前状态不可跳转", "warn");
    };
    if (e.hisList) {
      e.hisList.onclick = (ev) => {
        const li = ev.target.closest("[data-vid]");
        if (!li) return;
        this._resumeHistory(li.dataset.vid);
      };
    }
  }

  async _doSearch() {
    const kw = (this.els.searchInput.value || "").trim();
    if (!kw) { this.toast("请输入搜索关键词", "warn"); return; }
    this.toast(`正在搜索：「${kw}」…`, "ok");
    const src = activeSource();
    const ok = await this.fsm.search(kw);
    if (ok) this.toast(`搜索完成：${activeSource().label} 命中 ${this.fsm.model.mainQueue.items.length} 部`, "ok");
    else this.toast(`「${kw}」无结果，或当前源（${src.label}）不支持搜索`, "err");
  }

  _tryRecover() {
    const snap = this.snapshot.constructor.read();
    if (!snap) { this.toast("无可用快照", "warn"); return; }
    this.fsm.recoverCollection(snap);
    this.toast(`已从快照恢复已退出合集（${snap.collectionId}）`, "ok");
  }

  renderHistory() {
    if (!this.els.hisList || !this.history) return;
    const list = this.history.list().slice(0, 50);
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    this.els.hisList.innerHTML = list.length ? list.map((r) => `
      <li data-vid="${r.id || r.videoId}">
        <span class="idx">${r.category || "剧"}</span>
        <span class="t">${r.title}</span>
        <span class="note">${r.watched ? `<svg class="tick"><use href="#i-check"/></svg>已看完` : (r.progressSec > 3 ? `看到 ${fmt(r.progressSec)}` : "")}</span>
      </li>`).join("")
      : `<li class="empty">暂无观看记录 —— 看过的短剧/漫剧会出现在这里</li>`;
  }

  async _resumeHistory(videoId) {
    const rec = this.history?.get(videoId);
    if (!rec) return;
    const fromId = activeSource().id;
    this.toast(`续播：${rec.title}`, "ok");
    const res = await this.fsm.resumeHistory(rec);
    if (res && res.ok === false) { this.toast(res.msg || "续播失败", "err"); return; }
    if (activeSource().id !== fromId) this.populateSources();
  }

  renderAll() { this.renderState(); this.renderMain(); this.renderCollection(); this.renderPreload(); this.renderControls(); this.renderHistory(); }

  renderState() {
    const s = this.fsm.state;
    const cq = this.fsm.model.collectionQueue;
    let label = STATE_LABEL[s] || s;
    // 已退出合集特殊显示
    if (s === STATE.MAIN_QUEUE && cq?.exited) label = "已退出合集（续播中）";
    this.els.state.textContent = label;
    this.els.state.className = "state-badge s-" + s + (cq?.exited ? " exited" : "");
    const v = activeSource().getVideoMeta(this.fsm.model.currentVideoId());
    this.els.nowPlaying.textContent = v ? v.title : "—";
  }

  renderMain() {
    const mq = this.fsm.model.mainQueue;
    const st = this.fsm.state;
    const curIdx = (st === STATE.LOAD_COLLECTION && this.fsm.model.enteredMainIndex >= 0)
      ? this.fsm.model.enteredMainIndex
      : mq.pointer;
    const html = mq.items.map((it, i) => {
      const v = activeSource().getVideoMeta(it.videoId);
      const isCur = i === curIdx && (st === STATE.MAIN_QUEUE || st === STATE.LOAD_COLLECTION || st === STATE.FALLBACK);
      const replaced = this.fsm.model.lastReplacedVideoId && it.videoId === this.fsm.model.lastReplacedVideoId;
      const seed = mq.seed[i];
      const colId = seed?.collectionId;
      const cls = ["mq-item", isCur ? "cur" : "", replaced ? "replaced" : "", it.state === "played" ? "played" : ""].join(" ");
      const catLabel = seed?.category;
      const tag = replaced ? `<span class="tag replace">已替换</span>`
        : (colId ? `<span class="tag col" data-col="${colId}" ${catLabel ? `data-cat="${catLabel}"` : ""}>${catLabel ? catLabel : "合集"}<svg class="mini"><use href="#i-play"/></svg></span>`
                 : `<span class="tag">短剧</span>`);
      return `<li class="${cls}" data-idx="${i}" ${colId ? `data-col="${colId}"` : ""}>
        <span class="idx">${i + 1}</span>
        <span class="t">${v ? v.title : it.videoId}</span>${tag}</li>`;
    }).join("");
    this.els.mainList.innerHTML = html;
    this.els.mainPtr.textContent = `指针 #${mq.pointer + 1} / 共 ${mq.items.length}`;
  }

  renderCollection() {
    const cq = this.fsm.model.collectionQueue;
    if (!cq) { this.els.collWrap.style.display = "none"; return; }
    this.els.collWrap.style.display = "";
    const def = activeSource().getCollectionMeta(cq.collectionId);
    const exitedLabel = cq.exited ? "（已退出 · 续播中）" : "";
    this.els.collTitle.textContent = def
      ? (def.category ? `${def.category} · ${def.title}${exitedLabel}（点击任意一集可跳转）` : `${def.title}${exitedLabel}`)
      : `${cq.collectionId}${exitedLabel}`;
    const curVid = this.fsm.model.currentVideoId();
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    const html = cq.items.map((it, i) => {
      const v = activeSource().getVideoMeta(it.videoId);
      const isCur = it.videoId === curVid;
      const done = it.state === "played" && !isCur;
      const prog = it.progressSec || 0;
      const note = it.state === "played" ? `<svg class="tick"><use href="#i-check"/></svg>已看完` : (prog > 3 ? `看到 ${fmt(prog)}` : "");
      const cls = ["cq-item", isCur ? "cur" : "", done ? "done" : "", note ? "with-note" : ""].join(" ");
      return `<li class="${cls}" data-idx="${i}" title="点击跳到此集"><span class="idx">EP${i + 1}</span><span class="t">${v ? v.title : it.videoId}</span>${note ? `<span class="note">${note}</span>` : ""}</li>`;
    }).join("");
    this.els.collList.innerHTML = html;
    const tailInfo = cq.exited ? ` · 尾巴 ${this.fsm.model.exitedTailLength()} 集` : "";
    this.els.collPtr.textContent = `指针 EP${cq.pointer + 1} / 共 ${cq.items.length}${tailInfo}`;
  }

  renderPreload() {
    const c = this.preload.current;
    if (!c) { this.els.preload.textContent = "无目标（L0，下一首未定）"; this.els.preload.className = "preload-box idle"; return; }
    const v = activeSource().getVideoMeta(c.videoId);
    this.els.preload.textContent = `${v ? v.title : c.videoId} · 等级 ${c.level} · 阈值 ${c.triggerThreshold.toFixed(1)}s · 状态 ${c.state}`;
    this.els.preload.className = "preload-box " + (c.state === "running" ? "run" : c.state === "done" ? "done" : "idle");
  }

  renderMetrics(m) {
    const pct = (x) => (x * 100).toFixed(0) + "%";
    this.els.metrics.innerHTML = `
      <div class="metric"><b>${pct(m.collectionFinishRate)}</b><span>合集完播率</span></div>
      <div class="metric"><b>${pct(m.stitchKeepRate)}</b><span>退出保持率</span></div>
      <div class="metric"><b>${pct(m.fallbackRate)}</b><span>降级率</span></div>
      <div class="metric"><b>${m.tailDepth.toFixed(2)}</b><span>尾巴消费深度</span></div>
      <div class="metric sub"><b>${m.collectionEnter}</b><span>合集进入</span></div>
      <div class="metric sub"><b>${m.collectionAutoFinish}</b><span>自动完播</span></div>
      <div class="metric sub"><b>${m.stitchEnter}</b><span>退出合集</span></div>
      <div class="metric sub"><b>${m.fallback}</b><span>降级次数</span></div>`;
  }

  renderControls() {
    const s = this.fsm.state;
    const mq = this.fsm.model.mainQueue;
    const seed = mq.seed[mq.pointer];
    const cq = this.fsm.model.collectionQueue;
    const exited = cq?.exited;
    this.els.btnEnter.disabled = !(
      (s === STATE.MAIN_QUEUE && (seed?.collectionId || exited))
    );
    this.els.btnEnter.textContent = exited ? "重入合集" : "进入合集";
    this.els.btnExit.disabled = !(s === STATE.COLLECTION_QUEUE || exited);
    this.els.btnExit.textContent = exited ? "脱离合集" : "退出合集";
    this.els.btnSwitch.disabled = !(s === STATE.MAIN_QUEUE);
  }

  log(type, payload, kind = "") {
    const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const li = document.createElement("li");
    li.className = "log-item " + kind;
    li.innerHTML = `<span class="lt">${t}</span> <b>${type}</b> <span class="lp">${this._sum(payload)}</span>`;
    this.els.log.prepend(li);
    while (this.els.log.children.length > 60) this.els.log.lastChild.remove();
  }
  _sum(p) {
    try { return Object.entries(p).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" "); }
    catch { return ""; }
  }

  toast(msg, kind = "ok") {
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.textContent = msg;
    this.els.toast.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }
}
