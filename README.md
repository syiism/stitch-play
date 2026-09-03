# StitchPlay · 网页播放器（双队列 + 缝合态）

> **项目名：StitchPlay** —— 取自核心调度创新「缝合态（Stitch）」：退出合集不中断当前集，播完沿尾巴无缝续播。
> 依据 `video-player.md`（v1.0）与 `player-queue-v1.1.md`（v1.1）两份设计方案实现的可运行网页播放器。
> 状态机为内核、封闭事件总线对外、四类订阅者零侵入。纯原生 ES Module，无构建步骤。

## 运行

```bash
# 必须用带 mufan 同源代理（/mf/* → config.json 里 proxies 指定的上游）的静态服务：
# tools/server.py 自动以「工程根目录」为服务根，与解压位置无关，从任何地方启动都行。
python3 tools/server.py 8099
# 也可显式指定端口与根目录：python3 tools/server.py 8099 .
# 浏览器打开
open http://localhost:8099/index.html
```

视频源为在线短剧/漫剧（沐凡源，上游地址仅配置在服务端 `config.json` 的 `proxies[].upstream`，不写入前端/仓库），依赖外网；上游无 CORS 头，必须经 `tools/server.py` 的 `/mf/*` 同源代理访问。

## 演示路径（刷剧场景）

1. 主队列 = 沐凡发现页短剧流 / 漫剧流（**拆分为两个独立源**，下拉切换，各自主队列带 `category` 标签），**主队列是「发现入口」**：播完当前推荐位即**自动进入该剧合集连播**，不逐条推荐前进；
2. 合集连播 EP1→EP2→EP3…；播到某集点「⏏ 退出到缝合态」→ 当前集不中断，主队列槽位被**永久替换**为该集；
3. 当前集播完沿**合集尾巴**续播后续集；或点「⏭ 切到主队列下一项」立即脱离、回到发现流下一部；
4. 刷新页面 → 若处于缝合态，从 `localStorage` 快照**冷启动恢复**（懒恢复尾巴，带进度续播）；
5. 顶栏右侧「📱 竖屏滑动模式」→ 抖音式全屏卡片，**上滑/下滑**切换推荐与剧集（手势/滚轮/方向键三通道）。

## 架构与 ADR 对照

| 设计条目 | 实现文件 | 说明 |
| --- | --- | --- |
| 双队列 + 缝合态模型（v1.0 §三） | `queueModel.js` | MainQueue / CollectionQueue / StitchContext 数据结构 |
| 状态机内核 · 转换表唯一真相源（v1.0 §4.2 / ADR-10） | `stateMachine.js` | `TABLE` 即 §4.2 状态转换表；输入事件进、输出事件出 |
| 封闭事件目录总线（ADR-10 §4） | `eventBus.js` | `EVENT` 目录封闭、载荷只述事实、订阅者只读 |
| 指针消费即前进 + 预支（ADR-1） | `stateMachine.js` | 进入合集前预支主队列指针，退出衔接位置确定 |
| 主队列替换永久生效（ADR-4） | `stateMachine.js` `collExitToStitch` | 进入缝合态时首集→实际播放集，刷新前不回退 |
| 缝合标记持久化 · 锚点快照 + 懒恢复（ADR-8） | `snapshot.js` | 仅落盘意图锚点（<1KB）；尾巴按需从接口重取 |
| 预加载 · 单槽位状态驱动 + L0-L3（ADR-9） | `preload.js` | 状态-目标矩阵裁决；剩余时长触发；网络封顶 |
| 合集预热 · 列表预取订阅者（ADR-9 互补） | `collWarmup.js` | 主队列当前卡片带合集 → 后台预取分集列表入适配器缓存；点击「进入合集」命中缓存，LoadCollection 中间态从数百毫秒缩短到近零 |
| 主队列刷新 · 白名单 + 冷却 + 缝合态挂起（ADR-11） | `stateMachine.js` `requestRefresh` | 五类触发；30min 冷却；缝合态挂起至项边界 |
| 埋点 · 总线纯订阅 + 双阈值批量上报（ADR-12） | `tracker.js` | 6 事件 / 4 北极星指标 / 满 20 条或 30s 上报 |
| 主队列播完 → 自动进合集 | `stateMachine.js` `mainItemEnded` | 刷剧场景：主队列是发现入口，播完即进入当前推荐位所属合集（不消费前进）；无合集的独立项才回退旧语义 |
| 合集加载降级路径（v1.0 §5.1） | `sources/mufanAdapter.js` `stateMachine.js` | 超时静默重试→降级；0 条先提示→降级 |

## 视频源兼容层（归一化 + 可切换）

播放器的「数据从哪来」被收口到一个**视频源兼容层**（`src/sources/`），让内核（状态机 / 播放器 / UI / 预加载）只认一种规范元素，不关心各源原始字段差异。**新增或切换视频源，只动 `sources/` 目录，内核零改动。**

### 规范元素 `QueueItem`（所有源必须归一为此）

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `videoId` | string | 稳定 id（合集内 / 全局唯一） |
| `title` | string | 展示标题 |
| `src` | string | 可播放 URL（相对 / 绝对均可） |
| `poster` | string\|null | 封面图 |
| `duration` | number\|null | 时长（秒），预加载阈值用；缺省走默认阈值 |
| `collectionId` | string\|null | 所属合集；null = 独立短片 |
| `episodeIndex` | number\|null | 在所属合集内的下标 |
| `source` | string | 提供该元素的适配器 id（溯源） |
| `raw` | object | 源原始 payload（调试 / 源特定字段透传） |

### 适配器契约（内核只调用以下方法）

```js
async listMainQueue(): QueueItem[]                              // 主队列推荐流（每项带 collectionId 标记）
async listCollection(id): { collectionId, title, items: QueueItem[], startPointer }
appendMainQueue(count): QueueItem[]                            // 翻到底续拉（演示同步）
getVideoMeta(videoId): QueueItem | null                        // 已拉取则同步返回（渲染/播放用）
getCollectionMeta(id): { collectionId, title } | null          // 合集标题
// —— 可选扩展（内核 feature-detect，未实现则跳过）——
async search(keyword): QueueItem[] | null                      // 按本源语义搜索并归一化
async resolveSrc(videoId): string | null                       // 懒解析可播放地址
```

### 已内置源

#### 声明式配置源（推荐）

**零代码接入**：对于简单 REST API 视频源，无需编写 JavaScript，只需在 `config.json` 中声明式配置即可接入。使用 `DeclarativeSource` 通用适配器，通过 JSON 配置定义端点、字段映射、转换管道等。

配置示例（`config.json` 的 `sources` 数组中）：
```json
{
  "id": "my-source",
  "label": "我的视频源",
  "mode": "declarative",
  "proxy": "mf",
  "config": {
    "endpoints": {
      "discover": "/api/discover",
      "search": "/api/search",
      "directory": "/api/directory",
      "video": "/api/video"
    },
    "params": {
      "discover": { "type": "recommend" },
      "search": { "limit": 20 }
    },
    "mapping": {
      "videoId": "video_id",
      "title": "video_title",
      "src": "play_url",
      "poster": "cover_image",
      "duration": "duration_sec",
      "collectionId": "series_id",
      "episodeIndex": "episode_order",
      "category": "_category_short"
    },
    "transform": {
      "videoId": ["string", { "prefix": "my-" }],
      "title": "trim",
      "duration": "number"
    },
    "listPath": "data.items",
    "collectionItemsPath": "data.episodes",
    "_category_short": "短剧"
  }
}
```

核心功能：
- **端点配置**：discover/search/directory/video 接口路径
- **固定参数**：各接口的默认查询参数
- **字段映射**：API 返回字段 → QueueItem 字段（支持多候选字段名）
- **转换管道**：前缀/后缀/trim/number/string 等内置转换器
- **数据路径**：支持点号嵌套（如 `data.items`）
- **分类标签**：通过 `_category_xxx` 自定义分类值

#### 沐凡源（声明式配置实现）

- **`mufan-short` = 沐凡 · 短剧**、**`mufan-manju` = 沐凡 · 漫剧**，各自主队列，运行时下拉切换（内核零改动）；
- **主队列 = 发现页**：`/api/bookmall/cell/change?genre_tab=4|5`（4=短剧、5=漫剧），当前源取前 5 部，元素带 `category` 标签（UI 显示「短剧 ▶」「漫剧 ▶」）；
- **合集 = 剧集目录**：`/api/directory?book_id=` → 一部剧一个合集，分集即 EP（`mf-ep-<item_id>`）；
- **取流懒解析**：`src` 起播时才经 `/api/video?item_id&book_id&type=json&proxy=1` 解析（适配器契约可选方法 `resolveSrc(videoId)`，播放器自动支持），解析后回填 `src/duration/poster` 供预加载复用；
- 发现页卡片自带 `vid`（首集 id）→ 剧集头 `mf-drama-<series_id>` 无需先拉目录即可取流；
- 翻到底续拉 = 发现页首屏剩余卡片缓冲（上游 `offset` 被忽略）；
- **合集列表缓存 + in-flight 去重**：`listCollection` 用 `Map<promise>` 缓存，预热请求与正式进入请求共享同一 in-flight promise；只缓存「成功且非空」结果；
- **搜索（短剧/漫剧各自语义）**：控制台顶部搜索框 / 竖屏 HUD「🔍」→ `fsm.search()` → 调用当前源的 `search(keyword)`。沐凡源经 `/api/search?key=&tab_type=`（短剧 `11` / 漫剧 `19`，按源实例分类），结果 `video_data[0]` 归一化为 `QueueItem` 并**替换主队列**（竖屏：结果作为推荐流卡片，上滑逐个浏览、可进入合集；刷新回到发现流）；搜索不污染发现流去重；
- **CORS**：上游无 CORS 头，浏览器部署须经同源代理 —— `tools/server.py` 把 `/mf/*` 反代到 `config.json` `proxies` 指定的上游（支持 Range 透传）；`baseUrl` 在 `config.js` `sources.mufan` 配置。**安全：真实上游地址仅存服务端 `config.json`（`proxies[].upstream`），`server.py` 下发 `config.json` 时自动剥离 `upstream`，前端/仓库不携带接口地址。**

### 切换 / 新增源

- **声明式配置（推荐）**：对于简单 REST API 源，直接在 `config.json` 中添加配置项即可，无需编写代码。见上文配置示例。
- 运行时：页面顶部「视频源」下拉框切换（当前为**沐凡 · 短剧 / 沐凡 · 漫剧**两项，各自主队列），内核经 `fsm.switchSource()` 重建主队列、清空合集/缝合态、回到主队列，全程 0 运行时错误。
- 代码：在 `sources/index.js` `registry.register(new XxxAdapter())` 即可上架；`registry.use("id")` 设定默认源。内核只认规范 `QueueItem`，不关心各源原始字段差异。

> 归一化核心：`schema.js` 的 `normalize(raw, mapping, sourceId)` 把任意原始字段按 `mapping` 映射成 `QueueItem`，未列出的字段尝试同名透传。可选 `category` 字段用于源侧分类（短剧/漫剧）的 UI 区分。

## 声音策略（浏览器自动播放限制）

浏览器禁止「无用户手势的有声自动播放」，因此起播默认静音；**用户与页面发生首次交互（点击/按键）后自动解除静音**（`player.js` 的 `unlockAudio`），也可用控件里的「🔊/🔇」按钮手动开关。

**音量等级**：竖屏滑动 UI 的声音键提供竖向滑块（`swipe.html` 的 `#volRange`，`player.js` 的 `setVolume/getVolume`），可在 0–1 间精细调级；调高到 >0 会自动取消静音，同时显示等级进度填充。交互按设备区分：鼠标设备悬停声音键展开、点击开关静音；触屏设备点按声音键会展开大号竖向滑杆专门调音量（拖到 0 即静音，避免误触静音），点其它区域收起。切源/切集时**静音状态与音量等级都跟随用户选择**，不会重置回默认。

## 元素播放状态保留（v1.0 §六：PlaybackState）

队列的**每个元素都保留自己的播放状态**（`state` / `progressSec` / `durationSec`，见 `queueModel.js` `makeItem()`），回看不再从 0 开始：

- **进度回写**：`<video>` 的 `timeupdate` → `fsm.onProgress(current, duration, …)`，内核把当前播放位置写回**当前元素**（缝合态当前集不在队列元素上，记在缝合上下文 `stitch.progressSec`）。内核统一写，UI/播放器不碰队列——单一真相源不变。
- **队列切换继承**：主队列切进合集时，主队列里同 `videoId` 元素（如正在播的推荐位恰为本合集 EP1）的进度/时长/已播状态**并入合集元素**——画面本来就无缝（同视频不重载），进度记录同样连续；跳走再跳回续播的是完整进度，不会因主队列与合集两份记录分叉而丢失。
- **续播定位**：回看（下滑）/手动选集/冷恢复触发重载时，`player.js` 在 `loadedmetadata` 后调 `fsm.getResumePosition(videoId)` 跳到记录进度。进度 ≤3s 或已播完（≥ duration−1）视为无进度，直接从头。
- **播完归零**：主队列/合集「自然播完」时该元素 `progressSec` 归零（下次从头）；滑动跳过则保留进度（没看完就是没看完）。
- **缝合态离开再回来**：快照新增 `currentProgressSec`，`visibilitychange`(hidden)/`pagehide` 时补写；冷启动 `recoverStitch` 带进度恢复，从断点继续。
- **懒恢复不丢状态**：缝合尾巴懒重取时，按 videoId 保留原队列元素已有的 `state/progressSec/durationSec`。

## 手动选集

合集态 / 缝合态可跳到合集任意一集，内核入口 `fsm.jumpToEpisode(index)`（输入 `SELECT_EPISODE` 进转换表，两个状态各自路由）：

- **合集态** `collJumpEpisode`：只挪指针，当前集进度保留在元素上；发出 `CollectionEntered {pointerSource:"manualJump"}`。
- **缝合态** `stitchJumpEpisode`：旧当前集进度落回其合集元素 → 目标集之后的合集剩余**重铺为新尾巴**（各元素进度随迁）→ 从目标集的记录进度续播；发出 `StitchEntered {jumped:true}`。
- **竖屏 UI**：右侧「☰」按钮打开底部**选集抽屉**——当前集高亮、看完 ✓、看一半显示「看到 m:ss」，点选即跳（往后的集用上滑动画、往前的用下滑动画）。
- **控制台 UI**：合集队列列表**点击任意一集直接跳转**，同样显示观看状态标注。

## 竖屏滑动 UI（`swipe.html`）

与控制台 UI 共享同一内核（状态机 / 事件总线 / 预加载 / 埋点 / 快照），只是「输入源」与「呈现形态」换了：

- **三种输入通道**都路由到 `fsm.swipeNext()` / `fsm.swipePrev()`（按状态裁决，UI 不改队列）：
  - **指针拖拽**：主轴位移 ≥ 60px（或 28px+260ms 轻扫），先判定轴向、方向锁定
  - **滚轮**：deltaY 超过阈值，450ms 节流锁避免连发
  - **键盘**：`ArrowDown` = 下一个 / `ArrowUp` = 上一个 / `Space` = 播放暂停
- **滑动语义（由内核 TABLE 裁决）**：

  | 当前状态 | 上滑（swipeNext） | 下滑（swipePrev） |
  | --- | --- | --- |
  | 推荐流 | 下一个推荐（消费，到尾自动续拉）；**当前项播完自动进入其所属合集** | 上一个推荐（不消费，可再看） |
  | 合集 | 下一集；末集上滑 = 播完自动回推荐流 | 上一集（不消费，可再滑） |
  | 缝合态 | 沿尾巴续播下一集；尾巴尽则脱离 | **拒绝**（尾巴单向，不支持回看 → toast 提示） |

- **HUD**：顶部状态徽标 + 视频源下拉 + 调试面板按钮；右侧竖排控件（声音/播放/**选集 ☰**/进入合集/退出）；左侧进度刻度（窗口化，主队列 #i/N 或合集 EPi/N）；底部分类标签 + 标题 + 副标题 + 进度条 + 滑动提示；点击视频 = 播放/暂停。
- **画面层**：deck 内只有 `<video>` + 加载指示 + 大播放键，**不叠加任何装饰层**——横屏内容在竖屏里的黑边保持纯黑，不做模糊封面填充（那会被误认为「遮罩」）。
- **过渡动画**：切换时卡片先飞出（translateY ±100% + 淡出），再从反向位置滑回（cubic-bezier ease + 淡入）；阻尼越界（首项下滑、末项上滑）给橡皮筋手感 + toast。
- **动画可打断**：上一次切换动画未结束时再次滑动，会**先强制收尾**（`_finishAnim()` 归位 + opacity 复位 + 解锁）再执行本次——连续快滑既不丢操作，也不会卡在半透明/半位移的中间态。
- **调试面板**：右上角「⋯」滑出，显示状态机状态 / 主队列指针 / 合集指针 / 缝合态 / 预加载 / 指标 / 最近 40 条事件日志（与控制台 UI 同一总线）。

## 主队列 → 合集切换的顿挫优化

进入合集原本要经历 `LoadCollection` 中间态（徽标「加载合集…」、副标题「正在加载分集…」、rail 跳到预支指针位、分类标签闪到下一项），mufan 走真实网络往返，视频画面虽无缝（同视频不重载），但 UI 的数百毫秒跳变被感知为「卡了一下」。三层优化：

- **列表预取**：`collWarmup.js` 订阅 `StateChanged`/`ProviderReady`，主队列当前卡片带 `collectionId` 时后台 fire-and-forget 调 `listCollection`，结果落适配器缓存；切源清空重热。与 `PreloadArbiter`（流分片预热）互补——一个预拉「要播的流」，一个预拉「要进的列表」。
- **适配器缓存 + in-flight 去重**：`mufanAdapter` 的 `listCollection` 用 `Map<promise>` 缓存，预热请求与正式进入请求共享同一 in-flight promise；只缓存「成功且非空」结果，失败/空不缓存（保住降级语义）。
- **加载态渲染不跳变**：`LoadCollection` 态的分类标签、rail、主队列当前高亮统一改用 `enteredMainIndex`（进入前的槽位）而非预支指针——预支只影响「退出后从哪继续」的语义，不渗到 UI。

效果（实测）：预热命中后点击到「合集连播」徽标出现 **~30ms**（未预热 in-flight 共享 ~1500ms，提速约 45×），全程分类标签/rail/高亮零跳变。

## 单向数据流

```
输入(播放器/用户) → 状态机裁决 → QueueEvent 总线 → 订阅者(UI / 预加载 / 埋点 / 持久化) 只读
```

阈值全部集中在 `config.js`（ADR 要求走配置中心，代码不写死）。

## 目录

```
index.html          控制台 UI · 页面与布局
swipe.html         竖屏滑动 UI · 抖音式全屏卡片（上滑/下滑 切换合集与剧集）
styles.css         控制台样式
swipe.css          竖屏滑动 UI 样式
src/
  config.js         所有阈值（可配置）
  eventBus.js       封闭事件目录 QueueEvent 总线
  queueModel.js     队列逻辑层数据结构
  stateMachine.js   调度状态机内核（§4.2 转换表唯一真相源）+ 滑动/选集输入
  player.js         播放器控制器（DOM<video> ↔ 状态机，元素进度回写与续播定位）
  preload.js        预加载仲裁器（ADR-9）
  tracker.js        埋点订阅者（ADR-12）
  snapshot.js       缝合快照持久化（ADR-8）
  collWarmup.js     合集预热订阅者（列表预取，消除进入合集的顿挫）
  ui.js             控制台 UI 渲染订阅者（含视频源下拉）
  swipeUi.js        竖屏滑动 UI 渲染订阅者 + 手势引擎
  app.js            控制台串联入口（异步 boot）
  swipeApp.js       竖屏滑动 UI 串联入口
  sources/          视频源兼容层（归一化 + 可切换）
    schema.js         规范 QueueItem 契约 + normalize()（含 category 分类字段）
    adapter.js        适配器接口 + 注册表（SourceRegistry）
    mufanAdapter.js   沐凡源：发现页主队列，短剧/漫剧区分，取流懒解析，列表缓存
    index.js          注册入口 + 统一访问点
tools/
  server.py         静态服务 + /mf 同源代理（mufan 部署用）
```
