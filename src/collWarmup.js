// collWarmup.js · 合集预热订阅者（零侵入：只读总线 + 只调兼容层）
//
// 主队列正在播的推荐位若属于某合集 → 后台预取该合集的分集列表（fire-and-forget，
// 结果落入适配器缓存）。用户点「进入合集」时命中缓存，LoadCollection 中间态从
// 数百毫秒（模拟网络延迟 / 真实网络往返）缩短到近零——主队列 → 合集的切换
// 不再有可感知的顿挫。
//
// 与 PreloadArbiter（视频分片预热）互补：一个预拉「要播的流」，一个预拉「要进的列表」。

import { EVENT } from "./eventBus.js";
import { STATE } from "./queueModel.js";

export class CollectionWarmer {
  constructor(bus, fsm) {
    this.bus = bus;
    this.fsm = fsm;
    this._warmed = new Set(); // 已发起预热的 collectionId（每源会话内不重复）

    bus.on(EVENT.STATE_CHANGED, () => this._tick());
    bus.on(EVENT.PROVIDER_READY, () => { this._warmed.clear(); this._tick(); }); // 切源后缓存归零，重新预热
    this._tick();
  }

  /** 主队列当前卡片带合集 → 预热。只拉列表元数据（不拉视频流），失败静默——
   *  正式进入时走正常加载/重试/降级路径，预热失败不影响语义。 */
  _tick() {
    if (this.fsm.state !== STATE.MAIN_QUEUE) return;
    const mq = this.fsm.model.mainQueue;
    const colId = mq.seed[mq.pointer]?.collectionId;
    if (!colId || this._warmed.has(colId)) return;
    this._warmed.add(colId);
    this.fsm._source.listCollection(colId).catch(() => { this._warmed.delete(colId); });
  }
}
