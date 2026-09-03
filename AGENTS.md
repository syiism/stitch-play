# AGENTS.md · StitchPlay 协作规约

> 本文面向 AI Agent 与开发者，承载「不可打破的架构不变量、命令、约定、检查清单」；架构设计与功能说明见 [README.md](./README.md)（含 v1.0/v1.1 设计对照表）。
>
> 一句话：**纯原生 ES Module 网页播放器，无构建步骤，无 npm；以「状态机为内核、封闭事件总线对外、四类订阅者零侵入、配置中心收口阈值、单向数据流」为五大不变量。**

---

## 1. 项目概览

- **StitchPlay**：双队列（主队列 + 合集队列）+ **缝合态（Stitch）** 的刷剧网页播放器。
  「缝合态」= 退出合集不中断当前集，播完沿合集尾巴无缝续播（见 README「缝合态」）。
- **两个入口**共享同一内核：
  - `index.html` → 控制台 UI（`ui.js`）
  - `swipe.html` → 竖屏滑动 UI（抖音式全屏卡片，`swipeUi.js`）
- 视频源：沐凡（短剧/漫剧，上游地址见服务端 `config.json` 的 `proxies[].upstream`），依赖外网，上游无 CORS 头 → **必须经同源代理访问**（见第 3 节运行）。**真实上游地址仅存服务端配置，前端/仓库不得写死或携带**（`server.py` 下发 `config.json` 时自动剥离 `upstream`）。

## 2. 命令

纯静态工程，**无 package.json、无构建、无 lint、无单测脚本**（勿臆造 npm/yarn 命令）。

```bash
# 启动本地服务（静态 + /mf 同源代理）。日志写入 stitch-play.log
bash start.sh 8099            # 或
python3 tools/server.py 8099  # 可显式指定端口与根目录：python3 tools/server.py 8099 .
open http://localhost:8099/index.html   # 控制台 UI
# open http://localhost:8099/swipe.html # 竖屏滑动 UI
```

启动失败排查：`python3 tools/server.py` 会校验服务根目录存在 `index.html`；端口占用会打印 `kill $(lsof -t -i:PORT)` 提示。
停止：直接结束进程；无守护。

## 2.1 分支与提交流程

- **开发一律在 `dev` 分支进行**：任何代码 / 文档改动都先切换到 `dev`、在 `dev` 上提交并推送，**禁止直接在 `main` 上改动**。
- **`main` 只做同步、不直接开发**：`dev` 趋于稳定后，须经**用户明确确认**，才把 `dev` 当前代码**扁平化（单一提交）同步到 `main`** 并推送，不并入 `dev` 历史。
- **未经用户明确同意，不得自行把 `dev` 改动同步到 `main`**；仅在用户确认后执行"同步 + 推送"。

## 3. 目录速览

```
index.html           控制台 UI 页面
swipe.html           竖屏滑动 UI 页面
styles.css / swipe.css   对应样式
start.sh             一键启动脚本
src/                 内核 + 订阅者
  config.js             所有阈值（配置中心，代码不写死）
  queueModel.js         队列逻辑层数据结构（MainQueue/CollectionQueue/StitchContext）
  stateMachine.js       调度状态机内核（转换表唯一真相源）+ 滑动/选集输入
  eventBus.js           封闭事件目录 QueueEvent 总线
  player.js             播放器控制器（DOM<video> ↔ 状态机）
  preload.js            预加载仲裁器（ADR-9）
  collWarmup.js         合集预取订阅者（列表预热，消顿挫）
  tracker.js            埋点订阅者（ADR-12）
  snapshot.js           缝合快照持久化（ADR-8）
  ui.js / swipeUi.js    两个 UI 渲染订阅者
  app.js / swipeApp.js  两个入口串联（异步 boot）
  sources/              视频源兼容层（归一化 + 可切换；见第 6 节）
tools/
  server.py             静态服务 + /mf 同源代理
```

## 4. 五大架构不变量（改代码前必读，破坏=回归）

1. **状态机为内核、转换表唯一真相源**：`stateMachine.js` 的 `TABLE` 即 §4.2 状态转换表。所有输入（含滑动/选集）都进转换表裁决后 emit 输出事件。**不要**绕过状态机直接改队列/换页。
2. **封闭事件总线 + 单向数据流**：`eventBus.js` 的 `EVENT` 目录封闭；载荷只述事实、订阅者只读；数据流恒为
   `输入 → 状态机裁决 → QueueEvent 总线 → 订阅者(UI/预加载/埋点/持久化) 只读`。
   **不允许**订阅者反向写总线或直接改队列。
3. **单一真相源 + 内核统一写**：进度回写、元素状态更新只由内核统一做，UI/播放器不碰队列（例如元素进度由 `fsm.onProgress` 写回）。
4. **配置中心收口**：所有魔法数字/阈值必须进 `src/config.js`，代码不写死（ADR 要求上线走配置中心调优）。
5. **内核零侵入于数据源**：内核只认 `sources` 归一化的规范元素 `QueueItem`，不关心源原始字段。新增/切换视频源**只动 `sources/` 目录**，内核零改动。

> 配套的稳定性约定见各文件头部注释；跨文件机制（数据流、ADL）全部记录在 README 的「单向数据流」「ADR 对照」两节。

### 4.6 架构调整许可（architecture change license）

当实际实现中出现**架构性问题**（不变量之间冲突、某不变量严重阻碍功能落地、新增需求无法在不破坏现有设计的前提下满足等），**准许调整架构**，包括放宽或改写五大不变量本身上三条及其衍生约定。

必须先获得用户明确同意，**不得擅自偏离**。获准后须遵循：

1. 一次性、成系统地调整，避免局部打补丁留下后遗症。
2. **同步更新所有相关文档**，至少包括：`AGENTS.md`（本文档的相应小节）、`docs/` 下受影响的设计文档、`README.md` 的架构对照表与说明。
3. 在提交说明（commit message）与相关注释中**明确标注**本次架构调整、理由与影响面。
4. 保持调整的精简性：仅放宽确有必要的不变量，能保留的原则尽量保留。

## 5. 关键约束与陷阱（最容易踩）

- **纯 ES Module**：用 `export/import`，无构建步骤；不要引入 npm 依赖 / 打包器。
- **必须同源代理访问**：上游（沐凡源）无 CORS 头。浏览器侧一律经 `config.js` 的 `sources.mufan.baseUrl="/mf"`（`tools/server.py` 按 `config.json` 的 `proxies` 反代）；拖进度依赖 Range 透传，不要既绕代理又不带代理。**上游地址不进前端**：前端只见代理前缀，`server.py` 下发 `config.json` 会剥掉 `upstream`，仓库/文档不要出现真实接口地址。
- **浏览器自动播放限制**：起播默认静音；用户首次交互（点击/按键）后 `player.js` 自动解锁声音。切源/切集要**保留用户静音选择**，不要重置回静音。
- **进度语义**：自然播完 → 元素进度归零（下次从头）；滑动跳过 → 保留进度（没看完就是没看完）。续播定位用 `fsm.getResumePosition(videoId)`（≤3s 或已播完当无进度）。
- **主队列是「发现入口」**：主队列当前推荐位播完 = **自动进入该推荐位所属合集**（不消费前进）；仅无合集的独立项才回退「逐条推荐前进」的旧语义。改动前请先确认改的是哪条语义。
- **动画可打断**（竖屏 UI）：切换未结束再滑动要先强制收尾 `_finishAnim()`，否则会卡在半透明/半位移中间态（见 README「动画可打断」）。

## 6. 如何扩展

### 新增 / 切换视频源（只动 `src/sources/`）

#### 方式一：声明式配置（推荐，零代码）

对于简单 REST API 视频源，无需编写 JavaScript 代码，只需在 `config.json` 的 `sources` 数组中添加配置项即可接入。使用 `DeclarativeSource` 通用适配器，通过 JSON 配置定义：

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

**核心配置项**：
- `endpoints`: discover/search/directory/video 接口路径
- `params`: 各接口的固定查询参数
- `mapping`: API 返回字段 → QueueItem 字段映射（支持多候选字段名）
- `transform`: 转换管道（前缀/后缀/trim/number/string 等）
- `listPath` / `collectionItemsPath`: 数据路径（支持点号嵌套）
- `_category_xxx`: 自定义分类标签值

> **适用场景**：API 返回 JSON、字段结构清晰、无需复杂认证/签名逻辑的视频源。若需复杂逻辑，仍可使用方式二编写自定义适配器。

#### 方式二：自定义适配器类

1. 新增适配器类，实现 `sources/adapter.js` 接口方法：
   `listMainQueue()` / `listCollection(id)` / `appendMainQueue(count)` / `getVideoMeta(videoId)` / `getCollectionMeta(id)`（可选 `resolveSrc(videoId)` 供取流懒解析、`search(keyword)` 供搜索）。
2. 元素必须归一化为规范 `QueueItem`；用 `sources/schema.js` 的 `normalize(raw, mapping, sourceId)` 做字段映射（未列出字段尝试同名透传；`category` 字段用于生成 UI 的「短剧 ▶ / 漫剧 ▶」标签）。
3. 在 `sources/index.js` 用 `registry.register(new XxxAdapter())` 上架，`registry.use("id")` 设默认源。
   > 同一适配器可参数化为**多个源实例**：如 `mufanAdapter` 支持 `opts.category`，注册为 `mufan-short` / `mufan-manju` 两个独立源（各自主队列，下拉切换），是「按分类拆分源」的参考实现。
4. 若需同源代理，在 `tools/server.py` 增加对应反代前缀与 `config.js` 的 `baseUrl`。

> **搜索约定**：源实现可选 `async search(keyword): QueueItem[]`（按本源语义搜索并归一化，空数组=无结果）；内核 `fsm.search()` feature-detect，结果**替换主队列**进入（不持久化，刷新回发现流），并 emit `MAIN_QUEUE_REPLACED`（reason=`search`）。沐凡源按实例分类用 `/api/search?key=&tab_type=`（短剧 `11` / 漫剧 `19`）。新源若支持搜索，须在「已内置源」注明其搜索 API 语义。

### 新增订阅者（只读）
- 在 `app.js`/`swipeApp.js` 里订阅 `eventBus` 事件，按事件渲染/触发；不要回写总线。

## 7. 提交前检查清单

- [ ] 未破坏五大不变量（尤其不绕过状态机、不破坏总线封闭性）。
- [ ] 阈值放进了 `config.js`，没有新的魔法数字。
- [ ] 新增/修改视频源只动了 `sources/` 与 `config.js`，内核无改动。
- [ ] 改动遵守源架构设计（README 的 v1.0/v1.1 对照表），新增机制同步补充 README。
- [ ] 未引入 npm 依赖 / 未引入构建步骤。

## 8. 备注

- 设计文档 `video-player.md`、`player-queue-v1.1.md` 为历史方案依据，未放在本工程目录内；实现对照见 README 表格。
- 埋点：6 事件 / 4 北极星指标 / 满 20 条或 30s 上报（`config.js` 的 `tracker`），走纯订阅，不侵入内核。
- 竖屏调试面板（`swipeUi.js` `_bindConfig`）含**预加载热调区**：运行时改 `CONFIG.preload`，只覆盖「事件回调热读」的项（enabled/triggerRemainingSec/triggerRatio/minSinceStartSec/preloadBytesL2·L3，单位 KB）；其余配置仍改 `src/config.js`。改 CONFIG 用共享对象直写属性即可生效。