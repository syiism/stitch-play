# AGENTS.md · StitchPlay 协作规约

> 本文面向 AI Agent 与开发者，承载「不可打破的架构不变量、命令、约定、检查清单」；架构设计与功能说明见 [README.md](./README.md)（含 v1.0/v1.1 设计对照表，与 v1.2 重构说明）。
>
> 一句话：**纯原生 ES Module 网页播放器，无构建步骤，无 npm；以「状态机为内核、封闭事件总线对外、四类订阅者零侵入、配置中心收口阈值、单向数据流」为五大不变量。**
>
> 当前主线 `refactor/merge-stitch`：缝合态已**融入合集队列**（`exited` 标记），状态数 5→4，详情见 [docs/video-player-v1.2.md](./docs/video-player-v1.2.md)。

---

## 1. 项目概览

- **StitchPlay**：双队列（主队列 + 合集队列）+ **退出延续语义（缝合）** 的刷剧网页播放器。
  「退出延续」= 退出合集不中断当前集，播完沿合集尾巴无缝续播。v1.2 起该语义由**合集队列自身的 `exited` 标记**表达，不再有独立的缝合态/缝合快照（旧设计见 v1.0/v1.1，当前实现见 v1.2）。
- **入口页面**：
  - `index.html` → 控制台 UI（`ui.js`）
  - `swipe.html` → 竖屏滑动 UI（抖音式全屏卡片，`swipeUi.js`）
  - `rules.html` → 规则工坊（开发者工具，`rulesUi.js`）：声明式源规则教程 + 演练场（直接 import `ruleParser.js` 真引擎实时求值）+ 源配置生成器（表单填参 → 导出 `sources.d/*.json` 下载）；纯静态，无内核依赖。
- 视频源：**沐凡（短剧/漫剧）、兔兔（短剧/漫剧）**等多源，数据源定义存于 `sources.d/` 目录（每个源一个 JSON 文件，`*.example.json` 为模板，复制去掉后缀即生效；文件名排序决定加载顺序，首个为默认源），`server.py` 扫描合并后并入 `config.json` 下发（目录存在即**完全取代** config 内联 sources），`sources/index.js` 运行时注册。**所有源 `base` 一律留空提交**（仓库不携带任何上游地址），真实地址运行时注入：前端 `localStorage` 按源填地址（代理型上游配合「启用代理」开关，请求带 `?proxy_upstream=` 由 `server.py` 同源转发并兜底浏览器 UA）。上游无 CORS 头（沐凡）必须走代理；CORS 全开（兔兔）可前端直连。

## 2. 命令

纯静态工程，**无 package.json、无构建、无 lint、无单测脚本**（勿臆造 npm/yarn 命令）。

```bash
# 启动本地服务（静态 + ?proxy_upstream= 同源代理转发）。日志写入 stitch-play.log
bash start.sh 8099            # 或
python3 tools/server.py 8099  # 可显式指定端口与根目录：python3 tools/server.py 8099 .
open http://localhost:8099/index.html   # 控制台 UI
# open http://localhost:8099/swipe.html # 竖屏滑动 UI
```

启动失败排查：`python3 tools/server.py` 会校验服务根目录存在 `index.html`；端口占用会打印 `kill $(lsof -t -i:PORT)` 提示。
停止：直接结束进程；无守护。

## 2.1 分支与提交流程

- **日常开发通常在 `dev` 分支**：默认在 `dev` 上开发并提交推送，**禁止直接改 `main`**；`main` 只做同步。
- **集成/重构分支：`refactor/merge-stitch`**——以 main 为基线把"缝合态融入合集队列"，并从此分支合并 `dev` 的 UI（宫格九列 flex）与声明式数据源改动。在该分支上改动直接提交推送。
- **`main` 只做同步、不直接开发**：趋于稳定后，须经**用户明确确认**，才把当前代码**扁平化（单一提交）同步到 `main`** 并推送。
- **未经用户明确同意，不得自行把改动同步到 `main`**；仅在用户确认后执行"同步 + 推送"。

## 3. 目录速览

```
index.html / swipe.html    控制台 UI / 竖屏滑动 UI
rules.html / rules.css     规则工坊（声明式源教程 + 演练场 + 源配置生成器）
styles.css / swipe.css     对应样式（swipe.css 含宫格九列 flex 布局）
config.example.json        数据源/代理配置模板（复制为 config.json 使用）
sources.d/                数据源定义目录（每源一个 JSON 文件；*.example.json 为模板，server 扫描并入 config.json 下发）
start.sh                   一键启动脚本
src/                       内核 + 订阅者（+ src/sources/ 视频源兼容层）
  config.js                所有阈值（配置中心，代码不写死）
  queueModel.js            队列逻辑层（MainQueue / CollectionQueue・exited 标记）
  stateMachine.js          调度状态机内核（转换表唯一真相源，4 状态）
  eventBus.js              封闭事件目录 QueueEvent 总线
  runtimeConfig.js         运行时配置载入（config.json → CONFIG.runtime）
  player.js / preload.js / collWarmup.js / tracker.js / snapshot.js
  sourcePrefs.js           视频源运行偏好（baseUrl / 代理开关，localStorage）
  history.js               播放记录（localStorage，含续播）
  ui.js / swipeUi.js / app.js / swipeApp.js
  sources/                 视频源兼容层（见第 6 节）
tools/
  server.py                静态服务 + ?proxy_upstream= 同源代理转发（UA 兜底浏览器标识）
docs/                      video-player v1.0 / v1.1 / v1.2 设计文档
```

## 4. 五大架构不变量（改代码前必读，破坏=回归）

1. **状态机为内核、转换表唯一真相源**：`stateMachine.js` 的 `TABLE` 即状态转换表。所有输入（含滑动/选集）都进转换表裁决后 emit 输出事件。当前为 **4 状态**（主队列 / 加载合集 / 合集队列 / 降级），缝合语义并入合集队列的 `exited` 标记。**不要**绕过状态机直接改队列/换页。
2. **封闭事件总线 + 单向数据流**：`eventBus.js` 的 `EVENT` 目录封闭；载荷只述事实、订阅者只读；数据流恒为
   `输入 → 状态机裁决 → QueueEvent 总线 → 订阅者(UI/预加载/埋点/持久化) 只读`。
   **不允许**订阅者反向写总线或直接改队列。
3. **单一真相源 + 内核统一写**：进度回写、元素状态更新只由内核统一做，UI/播放器不碰队列（例如元素进度由 `fsm.onProgress` 写回；已退出合集期间进度写到**合集元素**而非主队列元素）。
4. **配置中心收口**：所有魔法数字/阈值必须进 `src/config.js`，代码不写死（ADR 要求上线走配置中心调优）。
5. **内核零侵入于数据源**：内核只认 `sources` 归一化的规范元素 `QueueItem`，不关心源原始字段。新增/切换视频源**只动 `sources.d/`（源定义）与 `src/sources/`（可选代码）**，内核零改动。

> 配套的稳定性约定见各文件头部注释；跨文件机制（数据流、ADL）全部记录在 README 的「单向数据流」「架构与 ADR 对照」两节。

### 4.6 架构调整许可（architecture change license）

当实际实现中出现**架构性问题**（不变量之间冲突、某不变量严重阻碍功能落地、新增需求无法在不破坏现有设计的前提下满足等），**准许调整架构**，包括放宽或改写五大不变量本身上三条及其衍生约定。

必须先获得用户明确同意，**不得擅自偏离**。获准后须遵循：

1. 一次性、成系统地调整，避免局部打补丁留下后遗症。
2. **同步更新所有相关文档**，至少包括：`AGENTS.md`（本文档的相应小节）、`docs/` 下受影响的设计文档、`README.md` 的架构对照表与说明。
3. 在提交说明（commit message）与相关注释中**明确标注**本次架构调整、理由与影响面。
4. 保持调整的精简性：仅放宽确有必要的不变量，能保留的原则尽量保留。

## 5. 关键约束与陷阱（最容易踩）

- **纯 ES Module**：用 `export/import`，无构建步骤；不要引入 npm 依赖 / 打包器。
- **上游地址不进仓库**：`sources.d/*.json` 的 `base` 一律留空提交，真实地址运行时注入——前端 `localStorage`（`player.custom.sourceBase.v1`）按源填写；无 CORS 头的上游（沐凡）配合「启用代理」开关走 `?proxy_upstream=` 由 `server.py` 转发（拖进度依赖 Range 透传），CORS 全开的上游（兔兔）可直连。`server.py` 代理转发时对非浏览器 UA 统一兜底浏览器标识（部分上游如兔兔强制校验）。
- **前端自定义源地址（`sourcePrefs.js`）**：源默认 `base` 为空（同源根路径），前端在 `localStorage`（`player.custom.sourceBase.v1`）按源填写真实地址，刷新后生效；「启用代理」开关开启时**所有请求改发同源根路径**（`window.location`），上游取自定义地址、未填则取源定义 base，经 `?proxy_upstream=` 由 `server.py` 同源转发（规避上游无 CORS 头与 https 混合内容拦截），不勾选则直连。
- **浏览器自动播放限制**：起播默认静音；用户首次交互（点击/按键）后 `player.js` 自动解锁声音。切源/切集要**保留用户静音选择**，不要重置回静音。
- **进度语义**：自然播完 → 元素进度归零（下次从头）；滑动跳过 → 保留进度（没看完就是没看完）。续播定位用 `fsm.getResumePosition(videoId)`（≤3s 或已播完当无进度）。
- **主队列是「发现入口」**：主队列当前推荐位播完 = **自动进入该推荐位所属合集**（不消费前进）；有已退出合集尾巴时**优先沿尾巴续播**；仅无合集的独立项才回退「逐条推荐前进」的旧语义。改动前请先确认改的是哪条语义。
- **单步退出 + 异 id 定位**：`collExit` 单步即可把当前集完全替换主队列槽位并保留进度（无需二次退出）；进入合集的起播定位按 `videoId`（规则 2A/2B）而非盲写 EP1，以兼容主队列卡 id（`drama-*`）与分集 id（`ep-*`）不同的体系（见 v1.2 §05/§06）。
- **标题规范（`episodeDisplayTitle`）**：退出合集后主队列与历史记录显示「剧名 + 第N集」，合集队列内保持「第N集」（v1.2 §08）。
- **动画可打断**（竖屏 UI）：切换未结束再滑动要先强制收尾 `_finishAnim()`，否则会卡在半透明/半位移中间态。

## 6. 如何扩展

### 新增 / 切换视频源（只动 `sources.d/` + 可选 `src/sources/`）

1. **声明式源（首选，零代码）**：在 `sources.d/` 下新建一个源 JSON 文件（`mode: "declarative"` + `config.endpoints / params / mapping`；字段规则映射：`mapping.items` 以 `$` 路径定位元素列表，其余字段值为规则字符串——`$` 路径（含 `[*]` 数组/对象通配）/模板插值或字面量，语法见 `ruleParser.js` 头部注释；`endpoints` 支持 `{item_id}`/`{book_id}` **路径占位符**（无占位符回落 query 语义）；`mapping.src` 可选声明取流地址规则；`collectionItemsPath` 定位目录分集数组（支持 `$` 规则——含 `[n]` 下标/`[*]` 通配展平/fallback 数组，兼容旧式点号路径）；`mapping.itemId`/`episodeTitle` 可选声明分集 id/标题规则（itemId 缺省 `["$.item_id", "$.itemId"]` 兼容蛇形/驼峰目录）），复制 `sources.d/01-mufan-short.example.json` 为模板即可接入简单 REST 视频源。文件名排序决定源加载顺序，首个为默认激活源。
   > 也可走**本机自定义源**：规则工坊生成器「保存到本机」把源定义存 localStorage（`player.custom.sources.v1`，与 sources.d 源 JSON 同形），`initSources` 注册时并入内存（同 id 覆盖 config 源），刷新页面即生效、不经服务端，适合个人试源；`sources.d/` 落文件则适合分发共享。
2. **代码适配器**：新增类实现 `sources/adapter.js` 接口方法：`listMainQueue() / listCollection(id) / appendMainQueue(count) / getVideoMeta(videoId) / getCollectionMeta(id)`（可选 `resolveSrc(videoId)`、`search(keyword)`）。
3. 元素必须归一化为规范 `QueueItem`；用 `sources/schema.js` 的 `normalize(raw, mapping, sourceId)` 做字段映射；`category` 字段用于生成 UI 的「短剧 ▶ / 漫剧 ▶」标签。
4. 在 `sources/index.js` 用 `registry.register(new XxxAdapter())` 上架，`registry.use("id")` 设默认源。
   > 同一适配器可参数化为**多个源实例**：声明式源用 `config.params` 区分（如沐凡 `genre_tab` 4/5、兔兔 `tab_type` 16/24 各注册短剧/漫剧两源），是「按分类拆分源」的参考实现。

> **搜索约定**：源实现可选 `async search(keyword): QueueItem[]`；内核 `fsm.search()` feature-detect，结果**替换主队列**进入（不持久化，刷新回发现流），并 emit `MAIN_QUEUE_REPLACED`（reason=`search`）。沐凡/声明式源搜索经 `/api/search?key=&tab_type=`（短剧 `11` / 漫剧 `19`）；声明式源 `params.search` 值/端点路径可含 `{keyword}` 占位接前端关键词（查询字段名随源自定义，如 `kw`/`query`），未声明占位时回落传统 `key=`；未配 `search` 端点的源搜索安全降级为空结果。新源若支持搜索，须在「已内置源」注明其搜索 API 语义。

### 新增订阅者（只读）
- 在 `app.js`/`swipeApp.js` 里订阅 `eventBus` 事件，按事件渲染/触发；不要回写总线。

## 7. 提交前检查清单

- [ ] 未破坏五大不变量（尤其不绕过状态机、不破坏总线封闭性）。
- [ ] 阈值放进了 `config.js`，没有新的魔法数字。
- [ ] 新增/修改视频源只动了 `sources.d/` 与 `src/sources/`，内核无改动。
- [ ] 改动遵守设计（README 对照表 / docs v1.2），新增机制同步补充对应文档。
- [ ] 未引入 npm 依赖 / 未引入构建步骤。

## 8. 备注

- 设计文档：`docs/video-player.md`（v1.0）、`docs/video-player-v1.1.md`（v1.1）、`docs/video-player-v1.2.md`（v1.2，缝合态融入合集队列的当前实现定稿）；`docs/api_simple.md` 为上游服务 API 速查。实现对照见 README 表格。
- 埋点：6 事件 / 4 北极星指标 / 满 20 条或 30s 上报（`config.js` 的 `tracker`），走纯订阅，不侵入内核。
- 竖屏调试面板（`swipeUi.js` `_bindConfig`）含**预加载热调区**：运行时改 `CONFIG.preload`，只覆盖「事件回调热读」的项（enabled/triggerRemainingSec/triggerRatio/minSinceStartSec/preloadBytesL2·L3，单位 KB）；其余配置仍改 `src/config.js`。改 CONFIG 用共享对象直写属性即可生效。