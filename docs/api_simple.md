# API 接口文档（速查版）

> **基础地址**：`http://<host>:1968`
> **统一前缀**：`/api`
> **响应格式**：统一为 `{ "code": 0, "msg": "ok", "data": { } }`，`code=0` 表示成功，负数表示失败。为兼容阅读端，`/api/*` 即使出错也返回 HTTP 200，成败一律看 body 里的 `code`。
> **设备密钥**：需签名/解密的端点由服务用设备池自动处理，调用方无需传密钥。
> **多 ID**：多数端点同时接受 `item_id`（单个）和 `item_ids`（逗号分隔批量）。
> **别名**：`key`/`query`、`book_id`/`bookId`/`fq_id` 等多写法并存，取第一个非空。

---

## 一、搜索

### `GET /api/search/cue`
搜索热词榜。

### `GET /api/search/suggest`
搜索输入联想。

### `GET /api/search`
搜索综合 / 听书 / 小说 / 漫画 / 短剧 / 漫剧 / 短篇，用 `tab_type` 区分。

| 参数 | 必填 | 默认 | 说明 |
|------|:----:|------|------|
| `key` 或 `query` | ✅ | — | 搜索关键词 |
| `tab_type` | 否 | `3` | `3`小说 / `2`听书 / `8`漫画 / `11`短剧 / `19`漫剧 / `4`短篇 |
| `offset` / `next_offset` | 否 | `0` | 分页偏移，存在 `next_offset` 时优先用后者 |
| `search_id` / `passback` | 否 | — | 上游搜索会话状态，翻页原样带回 |
| `search_type` | 否 | `default` | `default` 主源 / `fanqie` 备用源 |

```
GET /api/search?key=斗破苍穹&tab_type=3
GET /api/search?key=甜宠&tab_type=11&offset=10
```

---

## 二、书籍详情

### `GET /api/detail`
单本书籍详情（移动端）。

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `book_id` / `bookId` / `fq_id` | ✅ | 书籍 ID |

### `GET /api/book`
书籍详情 + 目录（Web API + ABogus 签名）。

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `book_id` / `bookId` | ✅ | 书籍 ID |

### `GET /api/multi_detail`
批量书籍详情，一次拉多本书目卡。

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `book_id` | ✅ | 多个 ID 逗号分隔 |

```
GET /api/detail?book_id=7087519624329169951
GET /api/multi_detail?book_id=7565826198656273432,7601604170944089112
```

---

## 三、章节目录

### `GET /api/directory`（别名 `GET /api/catalog`）
完整章节目录，返回 `data.item_data_list[]`（含 `item_id`、`title`）。

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `fq_id` / `book_id` / `bookId` | ✅ | 书籍 ID |

```
GET /api/directory?book_id=7087519624329169951
```

---

## 四、正文内容（统一入口）

### `GET /api/content`
**最核心的端点**，按参数自动路由：取正文 / 听书 / 详情 / 书评。

| 参数 | 必填 | 默认 | 说明 |
|------|:----:|------|------|
| `item_ids` / `item_id` | 条件 | — | 章节 ID（取正文/听书时必填） |
| `book_id` | 条件 | — | 书籍 ID（取详情/评论时必填，支持逗号分隔批量） |
| `ts` | 否 | — | `听书` = 音频模式 |
| `comment` | 否 | — | `评论` = 书评模式 |
| `tone_id` | 否 | `0` | 听书音色 ID |
| `count` / `offset` | 否 | `10`/`0` | 评论分页 |

```
GET /api/content?item_ids=7089685628191048227
GET /api/content?item_ids=7074990077704768542&ts=听书&tone_id=1
GET /api/content?book_id=7087519624329169951&comment=评论&count=10
```

### `GET /api/audio`
独立听书端点（等价于 `content?ts=听书`）。

| 参数 | 必填 | 默认 | 说明 |
|------|:----:|------|------|
| `item_id` / `item_ids` | ✅ | — | 章节 ID |
| `tone_id` | 否 | `0` | 音色 ID（`1`~`8` 为不同 AI 嗓音） |

---

## 五、DH 握手正文

### `GET/POST /api/full`
通过 DH 密钥交换 + AES-256 解密取正文，**不依赖正文解密用的设备密钥**。

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `book_id` | ✅ | 书籍 ID |
| `item_ids` / `item_id` | ✅ | 章节 ID，逗号分隔或 JSON 数组，单次最多 3000 个 |

```
GET /api/full?book_id=7087519624329169951&item_ids=7089685628191048227
POST /api/full   {"book_id":"...","item_ids":["..."]}
```

### `GET /api/download/txt`（别名 `GET /api/txt`）
小说 TXT 下载。服务端先取目录、再批量解密正文拼接纯文本。

| 参数 | 必填 | 默认 | 说明 |
|------|:----:|------|------|
| `book_id` / `bookId` / `fq_id` | ✅ | — | 书籍 ID |
| `limit` | 否 | `0` | 限制下载前 N 章，`0` 表示全本 |
| `batch_size` | 否 | `3000` | 每批正文数，上限 3000 |
| `format` | 否 | — | `json` 返回 JSON |
| `async` / `mode=async` | 否 | `0` | 为真时返回后台任务 `job_id` |
| `sync` | 否 | `0` | `format=json&sync=1` 强制同步返回完整 `content` |

异步任务配套：`/api/download/txt/status?job_id=<id>`（任务状态）、`/api/download/txt/result?job_id=<id>`（完成后返回 TXT）。

```
GET /api/download/txt?book_id=7087519624329169951
GET /api/download/txt?book_id=7087519624329169951&async=1
GET /api/download/txt?book_id=7087519624329169951&limit=100&format=json&sync=1
```

---

## 六、网页正文

### `GET /api/chapter`
抓 `fanqienovel.com` 网页正文，**不依赖签名**，自动还原被替换的字符。

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `item_id` / `item_ids` | ✅ | 章节 ID |

### `GET /api/raw_full`
原始正文，保留 HTML 标签（含图片章节）。

---

## 七、章节元信息

### `GET /api/item_info`
章节元数据（标题、字数等），**不需签名**。

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `item_ids` / `item_id` | ✅ | 章节 ID，支持批量 |

---

## 八、漫画

### `GET /api/manga`（别名 `GET /api/comic`）
获取漫画章节图片，AES-GCM 解密后通过 `/static` 临时文件提供。

| 参数 | 必填 | 默认 | 说明 |
|------|:----:|------|------|
| `item_id` / `item_ids` | ✅ | — | 章节 ID |
| `show_html` | 否 | `0` | `1` 时额外返回拼好的 `<img>` HTML |

---

## 九、短剧 / 漫剧视频

> 短剧与漫剧是同一套视频链路：搜索用不同 `tab_type`（短剧 `11` / 漫剧 `19`），但取流、播放、解密完全一致。

### `GET /api/video`
获取短剧/漫剧视频。`type=json` 时按三级链路取流：① VOD evideo（1080p 原片）→ ② 第三方直链 → ③ 官方 multi（常 CENC）。

| 参数 | 必填 | 默认 | 说明 |
|------|:----:|------|------|
| `item_id` / `item_ids` / `video_id` | ✅ | — | 视频/集 ID |
| `book_id` | 否 | — | 书籍/剧 ID |
| `type` | 否 | — | `json` = 简化输出（含可播放 `url`） |
| `prefer_1080` | 否 | `1` | 默认开 1080p 原片；`0` 跳过 ① |
| `proxy` | 否 | `0` | `1` 时 `url` 包成 `/api/video_proxy`（浏览器更稳） |
| `quality` | 否 | 最高 | `low` = 省流 |
| `direct` | 否 | `1` | `0` 禁用第三方直链 ② |

```
GET /api/video?item_id=7635674228238322712&book_id=7635672340797344792&type=json
```

### `GET /api/video_proxy`
代理视频/音频流，绕过 CDN 防盗链，支持 Range（拖进度条）。

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `url` | ✅ | 原始视频/音频 URL（完整 URL 编码） |

### `GET /api/video_decrypt` 🎬 需 ffmpeg
下载 CENC 加密视频 → ffmpeg 解密 → 标准 MP4，支持缓存和 Range。

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `url` | ✅ | 加密视频 URL |
| `key` | ✅ | CEK（16 字节 hex），通常由 `/api/video` 自动派生 |

### `GET /api/video_transcode` 🎬 需 ffmpeg
实时转码 ByteVC1(H.265) → H.264，适合不支持 HEVC 的设备降级播放。

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `url` | ✅ | 源视频 URL |

---

## 十、设备管理

### `GET /api/device_register`
安卓设备注册与密钥管理。

| 参数 | 默认 | 说明 |
|------|------|------|
| `action` | `register` | `register` 注册 / `status` 状态 / `refresh` 刷新密钥 |

### `GET /api/ios_register`
iOS 设备注册（TTEncrypt 通道）。

### `GET /api/ios_content`
用 iOS 密钥通过安卓签名通道取正文。

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `item_id` / `item_ids` | ✅ | 章节 ID |

---

## 十一、播放器 / 阅读器（HTML 页面）

浏览器可直接打开渲染页面。

| 端点 | 页面 | 关键参数 |
|------|------|----------|
| `GET /api/player` | 短剧 / 漫剧竖屏播放器 | `item_id`、`book_id`、`title`、`api_key` |
| `GET /api/manga_reader` | 漫画全屏滚动阅读 | `item_id`、`book_id`、`title`、`api_key` |
| `GET /api/novel_reader` | 小说阅读器（翻页/字号/夜间） | `item_id`、`book_id`、`title`、`api_key` |
| `GET /api/audio_player` | 听书/朗读播放器 | `item_id`、`book_id`、`mode`(`audio`/`tts`)、`tone_id`、`api_key` |

---

## 十二、听书时间轴

### `GET /api/wkcontent`
TTS 时间轴数据（字幕同步用）。

| 参数 | 必填 | 默认 | 说明 |
|------|:----:|------|------|
| `item_ids` / `item_id` | ✅ | — | 章节 ID |
| `tone_id` | 否 | `1` | 音色 ID |

---

## 十三、书籍分享

### `GET /api/book_share`
从详情提取书名/作者/简介/封面，拼出分享信息。

| 参数 | 必填 | 说明 |
|------|:----:|------|
| `book_id` / `bookId` | ✅ | 书籍 ID |

---

## 十四、Novel 直返通道

无需设备密钥解密，走 `novel.snssdk.com`。

| 端点 | 参数 |
|------|------|
| `GET /api/novel_content` | `item_id`/`item_ids` |
| `GET /api/novel_directory` | `book_id`/`bookId` |

---

## 十五、头条内容

| 端点 | 参数 |
|------|------|
| `GET /api/toutiao` | `item_id`/`item_ids` |
| `GET /api/toutiao_article` | `item_id`（group_id/thread_id） |

---

## 十六、设备池管理

### `GET /api/device_pool`
| 参数 | 默认 | 说明 |
|------|------|------|
| `action` | `list` | `list` 列出 / `register` 注册入池 / `delete` 移除 / `refill` 批量补充 |
| `device_id` | — | `delete` 时必填 |
| `count` | `3` | `refill` 批量数量 |

另有 RESTful 风格：`GET /api/devices`（列表）、`GET /api/devices/stats`（统计）、`POST /api/devices/register/android`、`POST /api/devices/register/ios`。

### 设备阅读权益（premium）
| 端点 | 说明 |
|------|------|
| `GET /api/devices/premium` | 权益状态摘要 |
| `POST /api/devices/premium/claim` | 对指定/整池设备补做领取 |
| `GET /api/device_pool?action=premium_status` | 兼容旧端点：权益状态 |
| `GET /api/device_pool?action=claim_premium&device_id=...` | 兼容旧端点：指定设备补领 |

---

## 十七、健康检查与统计

| 端点 | 说明 |
|------|------|
| `GET /api/health` | 运行时间、设备状态、失败概况（`stats` 字段） |
| `GET /api/stats` | 每端点完整统计（次数/失败/平均耗时）+ 失败概况 |
| `GET /api/ping`、`GET /ping` | 存活探针 |
| `GET /` | 健康页：浏览器返回极简 HTML；非 HTML 客户端返回基础 JSON |
| `GET /stats/daily` | 当日 + 昨日调用统计 JSON（需面板口令） |

```
GET /api/health
GET /api/ping
GET /api/stats
```

---

## 十八、书源下载

### `GET /api/booksource`
生成匹配当前服务地址的 Legado 书源（`{{host}}` 自动替换）。

| 参数 | 默认 | 说明 |
|------|------|------|
| `format` | `json` | `json` 纯数组 / `download` 触发下载 / `wrapped` 包装格式 / `html` 信息页 / `bubble` 气泡预览页 |

```
GET /api/booksource
```

> 直接把 `http://<host>:1968/api/booksource` 填进 Legado「网络导入」即可。

---

## 十九、OPDS 目录

供 Moon Reader / KOReader 等订阅。

| 端点 | 参数 | 说明 |
|------|------|------|
| `GET /api/opds` | — | OPDS 根目录 |
| `GET /api/opds/search` | `q` | 搜索 |
| `GET /api/opds/recommend` | — | 推荐 |
| `GET /api/opds/categories` | — | 分类列表 |
| `GET /api/opds/category/:category` | `category` | 六类分类书籍（`novel`/`audio`/`manga`/`video`/`manju`/`short`） |

---

## 二十、发现页

| 端点 | 参数 | 说明 |
|------|------|------|
| `GET /api/front` | `tab`（默认 `0`） | 发现页首页 |
| `GET /api/landing` | `category_id`✅、`offset`、`genre_type`、`gender` 等 | 分类落地页（细分标签书目） |
| `GET /api/explore` | `category`（默认 `recommend`） | 发现页（`/api/front` 别名） |
| `GET /api/bookmall/tab` | — | 书城顶部分类 tab |
| `GET /api/bookmall/cell/change` | `genre_tab`、`algo_type`、`offset`、`limit` | 新版发现页榜单/推荐 |
| `GET /api/recommend/homepage` | `tab_type`、`offset`、`limit` | 首页推荐（兼容入口，内部复用 `cell/change`） |
| `GET /api/related` | `book_id`✅ | 关联作品 |
| `GET /api/author` | `author_id`、`author_name`、`book_id` | 作者作品 |
| `GET /api/author_bookshelf` | `author_id`、`author_name`、`offset`、`count` | 作者书架 |
| `GET /api/category` | — | 分类标签 |
| `GET /api/category/books` | `category_id`、`gender`、`creation_status`、`word_count`、`offset`、`limit` | 分类筛选 |

常用 `genre_tab`：`2`小说、`3`出版、`4`短剧、`5`漫剧、`6`听书、`7`短篇。

```
GET /api/front?tab=1
GET /api/landing?category_id=261&gender=1&offset=0
GET /api/bookmall/cell/change?genre_tab=2&algo_type=101&offset=0&limit=12
GET /api/related?book_id=7237397843521047567
GET /api/author?author_id=2_7159445979974866176&author_name=月末影
```

### `GET /api/rank` 排行榜
聚合番茄公开榜单，归一化为标准书目结构。

| 参数 | 默认 | 说明 |
|------|------|------|
| `type` | `巅峰` | `巅峰`/`出版`/`热搜`/`爆更`/`黑马` |
| `offset` | `0` | 分页偏移（每页 30） |

```
GET /api/rank?type=巅峰&offset=0
GET /api/rank?type=爆更&offset=30
```

---

## 二十一、书籍富信息 / 相关推荐 / 章节摘要

| 端点 | 必填参数 | 用途 |
|------|----------|------|
| `GET /api/book_extra` | `book_id` | 书籍额外信息（detail 之外的补充字段） |
| `GET /api/book_recommend` | `book_id`（`source` 默认 `8`） | 阅读页「读者还看了」推荐书单 |
| `GET /api/related_books` | `book_id`（`req_type` 默认 `2`） | 书末/详情相关推荐流 |
| `GET /api/recommendations` | `book_id` | 三路官方场景回退推荐，排除当前书 |
| `GET /api/excerpts` | `book_id`（`limit`=20/`offset`=0） | 精彩书摘 / 高赞划线段落 |
| `GET /api/chapter_summary` | `item_ids`（`book_id` 可选） | 批量章节摘要（每章一句话简介） |
| `GET /api/catalog_infos` | `item_ids` | 目录富信息（字数/听书音色/md5/锁定状态） |
| `GET /api/catalog_rich` | `book_id` | 整书富目录聚合（并发补全字数/音色/摘要） |
| `GET /api/lost_item` | `book_id`（`req_type` 默认 `5`） | 追更到底后的续读推荐同类书单 |
| `GET /api/book_update` | 无（`query_type` 默认 `1`） | 书架书籍更新查询（是否有新章/新章数） |

```
GET /api/book_extra?book_id=7413335654987205657
GET /api/book_recommend?book_id=7413335654987205657&source=8
GET /api/excerpts?book_id=7612099728896969753&limit=20&offset=0
GET /api/chapter_summary?item_ids=7629268347338654232,7629268593888199192
GET /api/catalog_rich?book_id=7276384138653862966
GET /api/lost_item?book_id=7644566179968732222&req_type=5
```

---

## 二十二、登录态（番茄账号）

需在书源「🍅登录番茄账号」或手填「番茄登录Token」获取 `sessionid`，随后用这些端点拉取个人数据。`sessionid` 也接受 `?session=` / `?token=`。

| 端点 | 参数 | 说明 |
|------|------|------|
| `GET /api/book_user` | `sessionid`✅ | 番茄用户信息 |
| `GET /api/book_shelf` | `sessionid`✅、`group`、`page`、`limit`、`offset`、`meta` | 我的书架（Web 列表本地分页） |
| `GET /api/read_history` | `sessionid`✅、`offset` | 阅读历史 |
| `GET /api/app_shelf` | `sessionid`✅、`offset`、`meta` | 官方 App 书架 |
| `GET /api/shelf_tab` | `sessionid`✅ | 书架分组 tab |
| `GET /api/book_add` ⚠️ | `sessionid`✅、`book_id`✅、`book_type` | 加入书架（**实验性，当前不可用**） |
| `GET /api/book_remove` ⚠️ | `sessionid`✅、`book_id`✅、`book_type` | 移出书架（**实验性，当前不可用**） |

---

## 二十三、评论系统（11 个端点）

### 段评
| 端点 | 必填参数 |
|------|----------|
| `GET /api/comment_count` | `item_id` |
| `GET /api/chapter_comments` | `book_id`、`item_id`（`item_version`/`para_index`/`count`=10/`cursor`） |
| `GET /api/comment_replies` | `comment_id`（`book_id`=0/`item_id`/`count`=10/`cursor`） |

### 书评
| 端点 | 必填参数 |
|------|----------|
| `GET /api/comments` | `book_id`（`count`=10/`offset`=0） |
| `GET /api/comments_reply` | `book_id`、`comment_id`（`count`=10） |
| `GET /api/comments_reply_reply` | `book_id`、`reply_id`（`count`=10） |

### 章末评论
| 端点 | 必填参数 |
|------|----------|
| `GET /api/forum_id` | `book_id`、`item_id` |
| `GET /api/end_comments` | `book_id`、`forum_id`（`item_id`/`count`=10/`offset`=0） |
| `GET /api/end_comments_reply` | `book_id`、`post_id`（`count`=10/`offset`=0） |
| `GET /api/end_comments_reply_reply` | `book_id`、`group_id`、`comment_id`（`count`=10/`offset`=0） |

### 作家说
| 端点 | 必填参数 |
|------|----------|
| `GET /api/author_say` | `book_id`、`item_id` |

### 本地评论半屏页
| 端点 | 说明 |
|------|------|
| `GET /api/comment_viewer` | 本地评论半屏页（书源段评/章评/作家说展示用） |
| `GET /api/book_feature_viewer` | 书摘续读分享半屏页 |

---

## 二十四、正文尾部自定义内容

### `GET /api/content_footer`
返回一条正文尾部内容（书源小说/短篇正文末尾调用并追加）。返回 `data.content`/`data.mode`，按 `config.yaml` 的 `content_footer` 配置（`enabled`、`mode`、`items[].content`/`items[].weight`）生成；未启用或无内容时 `content` 为空串。

```
GET /api/content_footer
```

---

## 二十五、静态资源

| 端点 | 说明 |
|------|------|
| `GET /sy/{n}.json` | 发现页分类数据（`n`=1~6） |
| `GET /static/...` | 漫画解密后的临时图片等 |

---

## 二十五、服务状态

| 端点 | 说明 |
|------|------|
| `GET /openapi.json`、`GET /docs` | 兼容占位 |

---

## 附录：错误码

`/api/*` 始终返回 HTTP 200，看 body 的 `code`：

| code | 含义 |
|------|------|
| `0` | 成功 |
| `-1` | 参数错误（缺必填参数） |
| `-2` | 设备密钥问题（未注册 / 加载失败） |
| `-3` | 上游请求失败 |
| `-4` | 解析失败 / 响应缺字段 |
| `-5` | 解密失败 / ffmpeg 错误 |
