# StitchPlay · 网页播放器（双队列 + 合集退出标记）

> **项目名：StitchPlay** —— 取自核心调度创新「缝合（Stitch）语义」：退出合集不中断当前集，播完沿尾巴无缝续播。该语义在 v1.2 起**融入合集队列**（`exited` 标记），不再需要独立的缝合态。
> 依据 `video-player.md`（v1.0）、`video-player-v1.1.md`（v1.1）与 `video-player-v1.2.md`（v1.2，缝合态融入合集队列重构）三份设计方案实现的可运行网页播放器。
> 状态机为内核、封闭事件总线对外、四类订阅者零侵入。纯原生 ES Module，无构建步骤。当前实现以 v1.2 规则为准。

## 运行

```bash
# 本地静态服务 + ?proxy_upstream= 同源代理转发（代理型上游用）：
# tools/server.py 自动以「工程根目录」为服务根，与解压位置无关，从任何地方启动都行。
python3 tools/server.py 8099
# 也可显式指定端口与根目录：python3 tools/server.py 8099 .
# 浏览器打开
open http://localhost:8099/index.html
```

视频源为在线短剧/漫剧，数据源定义在 `sources.d/`（每源一个 JSON 文件，server 扫描并入 `config.json` 下发；目录存在即完全取代 config 内联 sources）。**所有源 `base` 一律留空提交**（仓库不携带上游地址），真实地址运行时注入：前端 `localStorage` 按源填写；无 CORS 头的上游（沐凡）配合「启用代理」开关走 `?proxy_upstream=` 由 `tools/server.py` 同源转发，CORS 全开的上游（兔兔）可直连。

## 演示路径（刷剧场景）

1. 主队列 = 发现页短剧/漫剧流（沐凡 / 兔兔多源，**拆分为短剧、漫剧独立源**，下拉切换，各自主队列带 `category` 标签），**主队列是「发现入口」**：播完当前推荐位即**自动进入该剧合集连播**，不逐条推荐前进；
2. 合集连播 EP1→EP2→EP3…；播到某集点「⏏ 退出并回归主队列」→ 当前集**完全替换**主队列对应槽位并保留进度，**单步即达、无缝续播**（无需二次退出）；
3. 当前集播完沿**合集尾巴**续播后续集；或点「⏭ 切到主队列下一项」立即脱离、回到发现流下一部；
4. 刷新页面 → 若处于已退出合集的延续中，从 `localStorage` 快照**冷启动恢复**（懒恢复尾巴，带进度续播）；
5. 顶栏右侧「📱 竖屏滑动模式」→ 抖音式全屏卡片，**上滑/下滑**切换推荐与剧集（手势/滚轮/方向键三通道）。

> 关于「缝合态」名称：v1.0/v1.1 曾把延续语义做成一等状态 `STITCH`，现已在 v1.2 重构中被**并入合集队列**（`collectionQueue.exited`），状态数 5→4。术语上仍可用"缝合/退出延续"，但代码与状态表已没有独立的缝合态，详见 [video-player-v1.2.md](./docs/video-player-v1.2.md)。

## 架构与 ADR 对照

| 设计条目 | 实现文件 | 说明 |
| --- | --- | --- |
| 双队列 + 合集退出标记模型（v1.2） | `queueModel.js` | MainQueue / CollectionQueue（`exited`/`replacedIndex`/`tailLazy`），缝合语义并入合集队列 |
| 状态机内核 · 转换表唯一真相源（v1.0 §4.2 / ADR-10） | `stateMachine.js` | `TABLE` 即转换表；4 状态（无独立缝合态），输入事件进、输出事件出 |
| 封闭事件目录总线（ADR-10 §4） | `eventBus.js` | `EVENT` 目录封闭、载荷只述事实、订阅者只读 |
| 指针消费即前进 + 预支（ADR-1） | `stateMachine.js` | 进入合集前预支主队列指针，退出衔接位置确定 |
| 单步退出 · 当前集完全替换主队列（v1.2 §06） | `stateMachine.js` `collExit` | 替换并保留进度，指针停在当前集，无缝续播 |
| 进入合集的两种起播定位（v1.2 §05，规则 2A/2B） | `stateMachine.js` `onLoadSuccess` | autoEnter 从 EP2、手动/历史按 videoId 定位，兼容异 id 体系 |
| 主队列替换永久生效（ADR-4） | `stateMachine.js` | 替换后刷新前不回退；主队列槽位=当前播放集 |
| 已退出合集快照 · 锚点 + 懒恢复（ADR-8） | `snapshot.js` | 仅落盘意图锚点（<1KB）；尾巴按需从接口重取 |
| 预加载 · 单槽位状态驱动 + L0-L3（ADR-9） | `preload.js` | 状态-目标矩阵裁决；剩余时长触发；网络封顶 |
| 合集预热 · 列表预取订阅者（ADR-9 互补） | `collWarmup.js` | 主队列当前卡片带合集 → 后台预取分集列表，点击「进入合集」近零延迟 |
| 主队列刷新 · 白名单 + 冷却 + 退出延续挂起（ADR-11） | `stateMachine.js` `requestRefresh` | 五类触发；30min 冷却；`collectionQueue.exited` 时挂起至项边界 |
| 埋点 · 总线纯订阅 + 双阈值批量上报（ADR-12） | `tracker.js` | 事件 / 北极星指标 / 满 20 条或 30s 上报 |
| 主队列播完 → 自动进合集 | `stateMachine.js` `mainItemEnded` | 优先沿已退出合集尾巴 → 无则自动进入当前推荐位合集 → 独立项才消费前进 |
| 合集加载降级路径（v1.0 §5.1） | `sources/*` `stateMachine.js` | 超时静默重试→降级；0 条先提示→降级 |
| 标题格式化 · 剧名+集数（v1.2 §08） | `sources/index.js` `episodeDisplayTitle` | 退出合集后主队列与历史记录显示「剧名 + 第N集」，合集内保持「第N集」 |
| 视频源运行偏好（baseUrl/代理开关） | `sourcePrefs.js` | `localStorage` `player.custom.sourceBase.v1`，刷新后优先于 config 生效 |

## 视频源兼容层（归一化 + 可切换）

播放器的「数据从哪来」被收口到一个**视频源兼容层**（`src/sources/`），让内核（状态机 / 播放器 / UI / 预加载）只认一种规范元素，不关心各源原始字段差异。**新增或切换视频源，只动 `sources/` 目录，内核零改动。**

数据源定义在 `sources.d/` 目录（每个源一个 JSON 文件；`*.example.json` 为模板，复制去掉后缀即生效）；`config.example.json` → 复制为 `config.json` 管理请求/代理参数（`server.py` 读取时自动并入 `sources.d/` 扫描结果后下发 `/config.json`）。每个源以 `mode: "declarative"` 声明（通用模板），`sources/index.js` 运行时初始化并注册。**全项目只有一个适配器 `DeclarativeSource`**，沐凡短剧/漫剧就是它的两组配置实例，新增源零代码。

### 规范元素 `QueueItem`（所有源必须归一为此）

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `videoId` | string | 稳定 id（合集内 / 全局唯一） |
| `title` | string | 展示标题 |
| `src` | string | 可播放 URL（相对 / 绝对均可，可懒解析） |
| `poster` | string\|null | 封面图 |
| `duration` | number\|null | 时长（秒），预加载阈值用；缺省走默认阈值 |
| `collectionId` | string\|null | 所属合集；null = 独立短片 |
| `episodeIndex` | number\|null | 在所属合集内的下标 |
| `category` | string\|null | 源侧分类（短剧/漫剧等），UI 用 |
| `source` | string | 提供该元素的适配器 id（溯源） |

### 适配器契约（内核只调用以下方法）

```js
async listMainQueue(): QueueItem[]                              // 主队列推荐流（每项带 collectionId）
async listCollection(id): { collectionId, title, items: QueueItem[], startPointer }
appendMainQueue(count): QueueItem[]                            // 翻到底续拉（缓冲）
getVideoMeta(videoId): QueueItem | null                        // 已拉取则同步返回
getCollectionMeta(id): { collectionId, title } | null          // 合集标题
// —— 可选扩展（内核 feature-detect，未实现则跳过）——
async search(keyword): QueueItem[] | null                      // 搜索并归一化
async resolveSrc(videoId): string | null                       // 懒解析可播放地址
```

### 已内置源

- **`DeclarativeSource`（声明式通用模板，唯一适配器）** — `declarativeSource.js`，只需在 `sources.d/` 下新建一个源 JSON 文件的 `config` 里声明 `endpoints / params / mapping` 即可接入简单 REST 视频源，无需写代码；字段解析走 `ruleParser.js` 规则引擎，`mapping` 中每个字段值为一条规则：`$` 开头按 JSON 路径解析（`$.a.b` 深层取值、`[n]` 下标、`[*]` 通配展平多层嵌套列表或键名动态的映射对象、整串路径保留原始类型；模板插值 `drama-$.series_id` 直接拼前缀），否则为字面量（如 `category: "短剧"`），数组形式为 fallback 依次尝试；`mapping.items` 以 `$` 路径定位元素列表（发现页/搜索共用，如 `"$.data.dataList"`、`"$.data.tab_item[*].cell_data[*].video_data"`）；`endpoints` 支持**路径占位符** `{item_id}` / `{book_id}`（如 `"/api/v1/videos/{item_id}"`，替换进路径且不再进 query，无占位符时回落 query 语义）；`mapping.src` 可选，声明取流响应中的播放地址规则（如 `"$.video_info.data.video_list[*].backup_url_1"`，缺省回落 `data.url ?? data.video_url`）：
  - **`mufan-short` = 沐凡 · 短剧、`mufan-manju` = 沐凡 · 漫剧**，均 `mode: "declarative"`，各自主队列，运行时下拉切换；主队列 = 发现页 `/api/bookmall/cell/change?genre_tab=4|5`（上游无 CORS 头，经「启用代理」+ `?proxy_upstream=` 转发）；
  - **`tutu-short` = 兔兔 · 短剧（`tab_type=16`）、`tutu-manju` = 兔兔 · 漫剧（`tab_type=24`）**，推荐流发现页（每次响应少量卡片且无翻页游标，不满页不预取）；上游 CORS 全开、支持前端直连；目录/取流走路径占位符端点（`/api/v1/books/{book_id}/directory`、`/api/v1/videos/{item_id}`）；接口速查见 [docs/tutu_api.md](./docs/tutu_api.md)；
  - **映射与 id 体系**：规则模板插值直接产出 `drama-{series_id}`（主队列卡）/ `col-{series_id}`（合集 id）/ `ep-{item_id}`（分集 id，合集目录构造）；
  - **合集** = `/api/directory` 剧集目录，分集按索引生成「第N集」标题；
  - **取流懒解析** `resolveSrc`：`ep-*` 走视频端点（query 或路径占位符），`drama-*` 先取首集 `item_id`，再经视频端点得到可播 URL；
  - **列表缓存 + in-flight 去重**：`listCollection` 用 `Map<promise>` 缓存，只缓存成功且非空；
  - **搜索**：沐凡源 `/api/search` + `tab_type`（短剧 `11` / 漫剧 `19`），按源实例分类；未配 `search` 端点的源搜索安全降级为空结果。

> **数据源配置模板**：`sources.d/` 下每个源一个文件，均以 `declarative` 模式声明完整 `config`（`endpoints`/`params`/`mapping` 规则等字段见 `src/sources/ruleParser.js` 头注释与 `sources.d/01-mufan-short.example.json` 示例）；文件名排序决定源加载顺序；配置缺失时前端回退到两套 declarative 沐凡源。

#### 前端自定义源地址（`sourcePrefs.js`）

`base` 默认为空（请求发同源根路径），前端可在 `localStorage`（`player.custom.sourceBase.v1`）中**按源自定义真实地址**：

- 覆盖：为某源填上游地址 → 刷新后生效；清空则回退同源根路径；
- 「启用代理」开关：开启后填 `http://` 绝对直链会改走 `?proxy_upstream=` 同源转发（规避 https 混合内容拦截），填 `https://` 则直连。

### 切换 / 新增源

- 运行时：页面顶部「视频源」下拉框切换（当前为**沐凡 · 短剧 / 沐凡 · 漫剧 / 兔兔 · 短剧 / 兔兔 · 漫剧**等项，各自主队列），内核经 `fsm.switchSource()` 重建主队列、清空合集/退出标记、回到主队列；
- 代码：新增源**无需写代码**——在 `sources.d/` 下新建一个源 JSON 文件（`mode: "declarative"`）即可（`registry.register` 由 `initSources` 统一执行）。内核只认规范 `QueueItem`。
- 本机自定义源（免落盘）：规则工坊（`rules.html`）生成器填参后点**「保存到本机」**——源定义存 localStorage（`player.custom.sources.v1`，与 sources.d 源 JSON 同形），`initSources` 注册时并入内存（同 id 覆盖 config 源），刷新播放器页面即生效，不经服务端；适合个人试源。导出 JSON 放入 `sources.d/` 则适合分发共享。

> 归一化核心：`schema.js` 的 `normalize(raw, mapping, sourceId)` 把任意原始字段映射成 `QueueItem`；`category` 字段用于源侧分类（短剧/漫剧）的 UI 区分。

## 声音策略（浏览器自动播放限制）

浏览器禁止「无用户手势的有声自动播放」，因此起播默认静音；**用户与页面发生首次交互（点击/按键）后自动解除静音**（`player.js` 的 `unlockAudio`），也可用控件里的「🔊/🔇」按钮手动开关。

**音量等级**：竖屏滑动 UI 的声音键提供竖向滑块（`swipe.html` 的 `#volRange`，`player.js` 的 `setVolume/getVolume`），可在 0–1 间精细调级；调高到 >0 会自动取消静音，同时显示等级进度填充。交互按设备区分：鼠标设备悬停声音键展开、点击开关静音；触屏设备点按声音键会展开大号竖向滑杆专门调音量（拖到 0 即静音，避免误触静音），点其它区域收起。切源/切集时**静音状态与音量等级都跟随用户选择**，不会重置回默认。

## 元素播放状态保留（v1.0 §六：PlaybackState）

队列的**每个元素都保留自己的播放状态**（`state` / `progressSec` / `durationSec`，见 `queueModel.js` `makeItem()`），回看不再从 0 开始：

- **进度回写**：`<video>` 的 `timeupdate` → `fsm.onProgress(current, duration, …)`，内核把当前播放位置写回**当前元素**。已退出合集期间（仍站主队列）进度写到**合集元素**而非主队列元素——主队列槽位已被替换为同一 videoId，语义一致。内核统一写，UI/播放器不碰队列。
- **队列切换继承**：主队列切进合集时，主队列里同 `videoId` 元素的进度/时长/已播状态**并入合集元素**——画面无缝、进度连续；跳走再跳回续播的是完整进度。
- **续播定位**：回看（下滑）/手动选集/冷恢复触发重载时，`player.js` 在 `loadedmetadata` 后调 `fsm.getResumePosition(videoId)` 跳到记录进度。进度 ≤3s 或已播完（≥ duration−1）视为无进度，直接从头。
- **播完归零**：主队列/合集「自然播完」时该元素 `progressSec` 归零（下次从头）；滑动跳过则保留进度（没看完就是没看完）。
- **退出合集再回来**：快照新增 `currentProgressSec`，`visibilitychange`(hidden)/`pagehide` 时补写；冷启动 `recoverCollection` 带进度恢复，从断点继续。
- **懒恢复不丢状态**：已退出合集尾巴懒重取时，按 videoId 保留原队列元素已有的 `state/progressSec/durationSec`。

## 手动选集

合集态 / 已退出合集态可跳到合集任意一集，内核入口 `fsm.jumpToEpisode(index)`（输入 `SELECT_EPISODE`）：

- **合集态** `collJumpEpisode`：只挪指针，当前集进度保留在元素上；发出 `COLLECTION_ENTERED {pointerSource:"manualJump"}`。
- **已退出合集态**（站主队列）：同样 `collJumpEpisode`，直接挪指针保持 `exited`，目标集之后的合集剩余为续播尾巴（各元素进度随迁）→ 从目标集记录进度续播。
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
  | 推荐流 · 已退出合集 | **沿合集尾巴续播下一集**；尾巴尽则销毁并切下一推荐 | **拒绝**（尾巴单向，不支持回看 → toast） |
  | 合集 | 下一集；末集上滑 = 播完自动回推荐流 | 上一集（不消费，可再滑） |

- **HUD**：顶部状态徽标 + 视频源下拉 + 调试面板按钮；右侧竖排控件（声音/播放/**选集 ☰**/进入合集/退出）；左侧进度刻度（窗口化，主队列 #i/N 或合集 EPi/N）；底部分类标签 + 标题 + 副标题 + 进度条 + 滑动提示；点击视频 = 播放/暂停。
- **画面层**：deck 内只有 `<video>` + 加载指示 + 大播放键，**不叠加任何装饰层**——横屏内容在竖屏里的黑边保持纯黑，不做模糊封面填充。
- **宫格九列 Flex 布局**（`swipe.css`，自 `dev` 并入）：推荐流卡片用 flex 实现九列等宽（`flex: 0 1 calc((100% - 96px) / 9)`，含间距），配合响应式断点，避免 grid 布局的上下重叠与滚动条隐藏问题（`bc47ded`）。
- **过渡动画**：切换时卡片先飞出（translateY ±100% + 淡出），再从反向位置滑回（cubic-bezier ease + 淡入）；阻尼越界（首项下滑、末项上滑）给橡皮筋手感 + toast。
- **动画可打断**：上一次切换动画未结束时再次滑动，会**先强制收尾**（`_finishAnim()` 归位 + opacity 复位 + 解锁）再执行本次。
- **调试面板**：右上角「⋯」滑出，显示状态机状态 / 主队列指针 / 合集指针 / 退出标记 / 预加载 / 指标 / 最近 40 条事件日志。

## 主队列 → 合集切换的顿挫优化

进入合集原本要经历 `LoadCollection` 中间态，mufan 走真实网络往返，UI 跳变被感知为「卡了一下」。三层优化：

- **列表预取**：`collWarmup.js` 订阅 `StateChanged`/`ProviderReady`，主队列当前卡片带 `collectionId` 时后台预取 `listCollection` 结果落适配器缓存；切源清空重热。与 `PreloadArbiter`（流分片预热）互补。
- **适配器缓存 + in-flight 去重**：`listCollection` 用 `Map<promise>` 缓存，预热请求与正式请求共享同一 in-flight promise。
- **加载态渲染不跳变**：`LoadCollection` 态的分类标签、rail、主队列当前高亮统一用 `enteredMainIndex`（进入前的槽位）而非预支指针。

效果（实测）：预热命中后点击到「合集连播」徽标出现 **~30ms**（未预热 in-flight 共享 ~1500ms，提速约 45×）。

## 单向数据流

```
输入(播放器/用户) → 状态机裁决 → QueueEvent 总线 → 订阅者(UI / 预加载 / 埋点 / 持久化) 只读
```

阈值全部集中在 `config.js`（ADR 要求走配置中心，代码不写死）。

## 目录

```
index.html          控制台 UI · 页面与布局
swipe.html         竖屏滑动 UI · 抖音式全屏卡片（上滑/下滑 切换合集与剧集）
rules.html         规则工坊 · 声明式源规则教程 + 实时演练场 + 源配置生成器（导出 sources.d JSON）
styles.css         控制台样式
swipe.css          竖屏滑动 UI 样式（宫格九列 flex 布局）
config.example.json        数据源/代理配置模板（复制为 config.json 使用）
sources.d/                数据源定义目录（每源一个 JSON 文件；*.example.json 为模板，server 扫描并入 config.json 下发）
src/
  config.js         所有阈值（可配置）
  eventBus.js       封闭事件目录 QueueEvent 总线
  queueModel.js     队列逻辑层数据结构（MainQueue / CollectionQueue・exited 标记）
  stateMachine.js   调度状态机内核（转换表唯一真相源，4 状态）+ 滑动/选集输入
  player.js         播放器控制器（DOM<video> ↔ 状态机，元素进度回写与续播定位）
  preload.js        预加载仲裁器（ADR-9）
  tracker.js        埋点订阅者（ADR-12）
  snapshot.js       已退出合集快照持久化（ADR-8）
  collWarmup.js     合集预热订阅者（列表预取，消除进入合集的顿挫）
  sourcePrefs.js    视频源运行偏好（baseUrl / 代理开关，localStorage 持久化）
  runtimeConfig.js   运行时配置载入（config.json → CONFIG.runtime）
  history.js        播放记录（localStorage 持久化，含续播）
  ui.js             控制台 UI 渲染订阅者（含视频源下拉）
  swipeUi.js        竖屏滑动 UI 渲染订阅者 + 手势引擎
  app.js            控制台串联入口（异步 boot）
  swipeApp.js       竖屏滑动 UI 串联入口
  sources/          视频源兼容层（归一化 + 可切换）
    schema.js        规范 QueueItem 契约 + normalize()（含 category 分类字段）
    adapter.js       适配器接口 + 注册表（SourceRegistry）
    ruleParser.js    声明式字段规则解析器（$ 路径 / [*] 数组·对象通配 / 模板插值 / 字面量 / fallback）
    declarativeSource.js  声明式通用模板源（唯一适配器，sources.d/ 声明即接入）
    index.js         注册入口 + 统一访问点 + episodeDisplayTitle
sources.d/          数据源定义目录（每源一个 JSON；*.example.json 为模板）
config.example.json 数据源/代理配置模板（复制为 config.json 使用）
tools/
  server.py         静态服务 + ?proxy_upstream= 同源代理（数据源部署用）
docs/               设计文档（video-player v1.0 / v1.1 / v1.2）
```