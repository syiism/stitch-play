# 播放器队列设计 · v1.2 缝合态融入合集队列（重构版）

> Playback Queue Design · Merge Stitch into Collection Queue

- 版本：v1.2
- 日期：2026-09-04
- 承接：v1.0（2026-09-01 · 已收口）、v1.1（2026-09-02 · 已收口）
- 分支：`refactor/merge-stitch`
- 状态：已落地（代码即真相，本文件描述当前实现）

## 目录

- [01 为什么重构](#01-为什么重构)
- [02 核心变更](#02-核心变更)
- [03 状态流转](#03-状态流转)
- [04 队列数据结构](#04-队列数据结构)
- [05 进入合集的两种起始位置](#05-进入合集的两种起始位置)
- [06 单步退出合集](#06-单步退出合集)
- [07 已退出合集的滞留与替换](#07-已退出合集的滞留与替换)
- [08 标题格式化规范](#08-标题格式化规范)
- [09 事件与快照](#09-事件与快照)
- [10 事件目录化简](#10-事件目录化简)
- [11 与 v1.0/v1.1 的关系](#11-与-v10v11-的关系)

## 01 为什么重构

v1.0 / v1.1 用「双队列 + 独立缝合态（StitchContext）」表达"退出合集仍沿尾巴续播"的延续语义：缝合态是与主队列、合集队列并列的**第三个运行时状态**，需要独立的 StitchContext、独立的 stitch* 动作、三路滑动分支与独立的快照结构。

落地后发现，缝合态本质只描述"一个**已退出**的合集还在身后"这件事，把它设成独立状态带来三处结构重叠：

1. **状态冗余**：退出合集后 Σ 上一刻仍在该合集只剩"尾巴续播"一种确定性去向，无需再单列一个 State；
2. **滑动三路分支**：缝合态与合集队列在滑动语义上高度相似（都是沿合集前进、拒绝回看），却要各自维护一套；
3. **退出成本高**：旧设计"进入缝合态"仍需两步心智（合并 + 标记），退出要绕状态机多态。

v1.2 的解法是**用集合队列自身的一个开关（`exited` 标记）表达缝合语义**，将缝合态"融回"合集队列：状态数 5→4，滑动分支 3→2，退出逻辑收敛为单步。本文件即为该重构的设计定稿。

## 02 核心变更

| # | 变更 | 旧（v1.0/v1.1） | 新（v1.2） |
| --- | --- | --- | --- |
| 1 | 状态模型 | 主队列 / 加载合集 / 合集队列 / **缝合态** / 降级，5 状态 | 主队列 / 加载合集 / 合集队列 / 降级，**4 状态**（删除 `STATE.STITCH`） |
| 2 | 退出载体 | StitchContext（active + remainingTail + replacedIndex） | 合集队列自身的 `exited / replacedIndex / tailLazy` 字段（`queueModel.js`） |
| 3 | 退出动作 | StitchEntered / stitch* 系列 | `collExit` 单步：当前集**完全替换**主队列槽位并保留进度，无需二次退出 |
| 4 | 滑动分支 | swipeNext/swipePrev 各 3 路（主/合集/缝合） | 各 2 路（主/合集），缝合语义并入主队列的 `exited` 判断 |
| 5 | 起播定位 | 历史指针 / 手动进入都走一套覆写逻辑 | **按 videoId 定位**，两种入口（autoEnter / manual+history）各有规则（见 §05） |
| 6 | 标题 | 由 `title` 字段透传 | `episodeDisplayTitle`：分集「剧名 + 第N集」，合集内保持「第N集」 |
| 7 | 快照 | 缝合快照（恢复为缝合态） | 已退出合集快照（恢复为 `exited=true` 的合集，见 `snapshot.js`） |
| 8 | 数据源 | 仅 `mufanAdapter.js` | 并入 `DeclarativeSource`（通用模板声明式源），`mode` 分支注册 |

核心不变量不变：**状态机内核、转换表唯一真相源、封闭事件总线单向数据流、配置中心收口、内核零侵入数据源**。

## 03 状态流转

### 3.1 状态集合（4 状态）

```js
STATE = {
  MAIN_QUEUE:       "MainQueue",
  LOAD_COLLECTION:  "LoadCollection",
  COLLECTION_QUEUE: "CollectionQueue",
  FALLBACK:         "Fallback",
};
```

### 3.2 转换表（`stateMachine.js` 的 `TABLE`）

| 当前状态 | 输入事件 | 目标状态 | 关键动作 |
| --- | --- | --- | --- |
| MainQueue | ITEM_ENDED | MainQueue/LoadCollection | `mainItemEnded`：自动进合集（滞留的已退出合集在此被替换）→ 消费前进 |
| MainQueue | ENTER_COLLECTION | LoadCollection | `enterCollection`（manual / autoEnter / history；滞留的已退出合集先整体替换） |
| MainQueue | SWITCH_MAIN_NEXT | MainQueue | `mainSwitchNext`（滞留的已退出合集不参与路由） |
| MainQueue | SWITCH_MAIN_PREV | MainQueue | `mainSwitchPrev`（不消费，可回看） |
| LoadCollection | LOAD_SUCCESS | CollectionQueue | `onLoadSuccess` 按入口定位起始集（§05） |
| LoadCollection | LOAD_RETRY / FAIL / EMPTY | Fallback | 静默重试 / 降级，见 v1.0 §5.1 |
| CollectionQueue | ITEM_ENDED | CollectionQueue / MainQueue | `collItemEnded`：末集播完 → 销毁合集回主队列 |
| CollectionQueue | EXIT_COLLECTION | MainQueue | `collExit` 单步退出（§06） |
| CollectionQueue | SWITCH_COLL_NEXT / PREV | CollectionQueue / MainQueue | 上下集；末集上滑 = 播完回主队列（autoFinish） |
| CollectionQueue | SELECT_EPISODE | CollectionQueue | `collJumpEpisode`（手动选集） |
| Fallback | RECOVERED | MainQueue | `fallbackRecovered` |

### 3.3 主队列"播完"决策树（`mainItemEnded`）

刷新语义沿 v1.0："主队列是发现入口，播完即自动进合集"。重构后决策顺序：

1. 当前项标记消费（played）；
2. **（已废除）尾巴恢复**：退出合集后合集仅滞留，`mainItemEnded` 恒走主队列语义（进合集/消费前进），滞留队列在下一次 `enterCollection` 时替换；
4. 主队列种子当前项带 `collectionId` → `enterCollection(colId, "autoEnter")` 自动进合集（不消费前进）；
5. 独立短片（无合集）→ 消费前进 / 翻到底续拉。

## 04 队列数据结构

### 4.1 QueueModel（`queueModel.js`）

```ts
QueueModel {
  mainQueue: {
    items: QueueItem[]
    pointer: number            // 消费即前进（ADR-1）
    seed: QueueItem[]          // 源自适配器 listMainQueue 的原始种子（含 collectionId）
  }
  collectionQueue: null | {
    items: QueueItem[]
    pointer: number
    collectionId: string
    exited: boolean            // ★ 退出语义开关：true = 已退出滞留（不销毁、不参与路由，下次进合集替换）
    replacedIndex: number      // 主队列被替换的槽位
    tailLazy: boolean          // （预留字段，恒 false；原尾巴懒恢复机制已废除）
  }
  lastReplacedVideoId: string|null   // 最近一次替换进来的 videoId（刷新锚） 
  enteredMainIndex: number           // 进入合集前的主队列槽位（预支语义）
  state: STATE
}
```

### 4.2 尾巴操作（替代原 stitch* 方法）

| 方法 | 语义 |
| --- | --- |
| `collectionMarkExited(replacedIndex)` | 退出合集：标记 `exited` + 记录替换槽位，**不销毁队列**（滞留，不参与路由） |
| `collectionUnmarkExited()` | 取消 `exited`（预留；现行路径以整体替换为主） |
| `exitedTailLength()` | 已退出合集的尾巴剩余长度（items.length − pointer − 1；仅调试展示） |
| `exitedTailAdvance()` | （预留）已退出合集沿尾巴前进一集 |
| `collectionDestroy()` | 销毁合集队列 |
| `collectionLoad(items, pointer, collectionId)` | 进入合集；主队列同 `videoId` 元素的播放状态并入合集元素 |

## 05 进入合集的两种起始位置

重构后，起播位置由**入口类型**决定，并按 `videoId` 定位而非盲写第 1 集：

| 入口 | entrySource | 起始位置 |
| --- | --- | --- |
| 历史续播 | `history` | 从历史记录的 `episodeIndex` / 视频 id 定位 |
| 自动进入（主队列播完） | `autoEnter` | **规则 2A**：主队列锚点视频在合集内命中 → 标记已播完，从其**下一集**起播；锚点不在合集内（异 id 体系）→ 视为 EP1 已播完，从 EP2 起播 |
| 手动进入 | `playAll` / `reenter` | **规则 2B**：按主队列锚点 `videoId`（剥 `ep-` 前缀归一）定位到对应分集，保留分集身份、仅并入锚点播放进度/状态；锚点不在合集内 → 并入 EP1 |

> **异 id 体系的处理（关键）**：沐凡 / 声明式源主队列卡片 id 为源下发的裸 item id（`mapping.videoId` 规则 `$.vid`，即首集/推荐集 item_id；缺失时回落 `drama-{series_id}`）、分集 id 为 `ep-{item_id}`，两套形态不同，因此**不能**直接 `cq.items[0].videoId === mainVid` 判断"锚点是不是 EP1"。统一改为按 `videoId` 归一比对（剥 `ep-` 前缀后 `findIndex`）定位；未命中时，规则 2A 走"EP1 已播完从 EP2 续播"、规则 2B 走"保留 EP1 身份只并入进度"。命中时同样只把锚点的播放进度/状态并入分集、保留分集身份（标题/集号），不整只覆写。这同时修复了"退出后重入误把当前集并进 EP1"的 bug（`8768f6b`）。

## 06 单步退出合集

`collExit` 取代旧的两步"进入缝合态 + 合并"，动作单一且语义清晰：

```js
collExit():
  // 目标视频 = 当前正在播放的合集视频
  mainReplacePreserve(this._enteredMainIndex, cq.items[cq.pointer])  // 完全替换主队列槽位，保留进度/时长/状态
  mainQueue.pointer = this._enteredMainIndex                           // 指针停在当前播放视频上
  COLLECTION_EXITED { exitType: "detach", ... }
  collectionMarkExited(this._enteredMainIndex)                        // ★ 标记 exited，滞留不销毁（§07）
  _transition(MAIN_QUEUE, "exit-collection")
```

- **单步即达**：退出后主队列指针已指向刚替换进来的那集，播放不中断、**无需第二次退出**（`d771039`）；
- **进度保留**：`mainReplacePreserve` 保留 `progressSec / durationSec / state`，与旧 `mainReplace`（重置为 played/0）区分，供后续续播与选集；
- **回主队列**：退出后即为主队列语义——滞留的已退出合集不参与任何路由（进度/滑动/刷新恒走主队列）；当前集播完按主队列语义自动进合集（`enterCollection` 先以 `tailConsumed` 替换滞留队列），锚点归一命中 → 从该剧的下一集续播。

## 07 已退出合集的滞留与替换

退出合集后合集队列标记 `exited` **滞留内存**：不销毁、不参与任何路由（进度/续播/滑动/刷新恒走主队列，`currentVideoId` 恒取主队列当前）。

| 场景 | 处理 |
| --- | --- |
| 退出后继续播放 | 主队列语义接管：当前集（已替换进主队列槽位）播完 → `mainItemEnded` 自动进合集；上/下滑 = 主队列上下一个推荐 |
| 进入下一个合集 | `enterCollection` 检测滞留的 `exited` 合集 → `tailConsumed` 事件整体替换（同异合集一视同仁，不做重入续指针） |
| 手动重新进入 | 「进入合集」按钮 / F 键在滞留态仍可用 → 走替换 + 规则 2B（锚点归一命中当前集） |
| 切源 / 搜索 | 同样以 `tailConsumed` 替换滞留合集 |
| 冷启动恢复 | `recoverCollection` 把快照进度落到主队列元素（续播上下文在主队列），合集以 `exited=true` 滞留等替换 |

## 08 标题格式化规范（`episodeDisplayTitle`）

统一了"退出合集后主队列 / 历史记录 / UI"三处的分集标题（`sources/index.js`）：

| 场景 | 显示 |
| --- | --- |
| 合集队列内 | 元素自身标题「第N集」（按队列指针 `cq.pointer + 1` 补集号） |
| 退出合集后主队列 / 降级态 | 「**剧名 + 第N集**」——由 `getCollectionMeta(collectionId).title` 与 `episodeIndex` 合成 |
| 历史记录（`history.js`） | 同上「剧名 + 第N集」（来自 `PROGRESS_UPDATE.title`） |

规则：元素带 `collectionId + episodeIndex` 时走合成；否则原样返回元素标题。这修复了"标题缺集号 / 多出'集'字 / 退出合集后主队列不显示剧名"的一组问题（`308d001`、`c42f234`、`3cdf116`）。

## 09 事件与快照

### 9.1 事件目录调整

- **删除**：`StitchEntered` / `StitchTailAdvanced` / `StitchExited`（缝合态已并入合集队列）；
- **新增语义**：`COLLECTION_EXITED.exitType` 取值为 `"detach"`（单步退出，合集标记 exited 滞留，快照据此写入）/ `"autoFinish"` / `"tailConsumed"`（滞留的已退出合集被替换/清理——下一次进入合集、切源/搜索等，快照据此清理）/ `"recovered"` / `"exitMarked"`（兼容保留）；快照与恢复走 `"recovered"`；
- **入口**：`COLLECTION_ENTERED.pointerSource` 取值为 `"manual"` / `"autoEnter"` / `"history"` / `"manualJump"`（`"reenter"` 仍可作为 entrySource 传入，落库为 `"manual"`）；
- `MAIN_QUEUE_REPLACED` 保留（替换主队列槽位，锚定刷新与快照）。

### 9.2 快照（`snapshot.js`）

- 名称语义由"缝合快照"改为"**已退出合集快照**"；
- 持久化不可再生的意图锚点（<1KB）：`collectionId / currentEpisodeIndex / currentVideoId / currentProgressSec / mainAnchorVideoId / replacedVideoId / savedAt`；
- 写入：`COLLECTION_EXITED(detach / exitMarked / recovered)` 与离开页面（pagehide / 隐藏）时补写当前进度；
- 清除：`autoFinish / tailConsumed / consumeMainItem`；
- 冷启动：`recoverCollection(snapshot)` 把快照进度经 `mainReplacePreserve` 落到主队列元素（续播上下文在主队列）、用单元素构建 `exited=true` 的滞留合集、`_transition(MAIN_QUEUE, "recover")`；
- 失效：schemaVersion 不匹配 / 7 天过期即弃。

## 10 事件目录化简（相对 v1.1 4.3）

v1.2 在不变的封闭目录里，把缝合相关的旧事件条目替换为合集退出标记语义的条目，完整目录以 `src/eventBus.js` 的 `EVENT` 为准。埋点（ADR-12）中的 `stitch_enter` / `stitch_exit` 北极星指标在合并模型下不再单独成态，相关完成率改由 `COLLECTION_EXITED`（`detach`/`autoFinish`）承载，口径如需保留可在看板端按集合标记折算。

## 11 与 v1.0/v1.1 的关系

- v1.0（`video-player.md`）：双队列 + 缝合态的五状态模型与 ADR-1~7，**起点**；其中"缝合态为一等状态"的部分在 v1.2 被重构取代，其余（预支、替换永久、降级路径）维持。
- v1.1（`video-player-v1.1.md`）：ADR-8~12（快照、预加载、事件总线、刷新、埋点）——**机制全部保留**，仅载体随缝合态合并而更新：
  - ADR-8（缝合标记持久化）→ 已退出合集快照（§09.2）；
  - ADR-9（预加载 L0-L3）不变，退出合集后即主队列语义，预加载目标为主队列当前/下一项；
  - ADR-10（事件目录）条目随 §10 化简；
  - ADR-11（主队列刷新）→ 滞留的已退出合集**不再挂起刷新**（退出即主队列语义，刷新照常执行）；
  - ADR-12（埋点）口径见 §10。
- v1.2（本文件）：缝合态融入合集队列后的当前实现定稿，**代码即真相**。

---

*本文件为重构后实现的状态设计定稿；任何后续改动请先更新本文件并回溯 `stateMachine.js` 的转换表。*