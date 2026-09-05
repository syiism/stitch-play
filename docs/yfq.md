# yfq-v2 API 文档

> 基于源码生成 · 最后更新: 2026-06-30

## 目录

- [概述](#概述)
- [通用说明](#通用说明)
- [健康检查](#健康检查)
- [书籍接口](#书籍接口)
- [章节接口](#章节接口)
- [评论接口](#评论接口)
- [搜索接口](#搜索接口)
- [媒体接口](#媒体接口)
- [作者接口](#作者接口)
- [头条内容](#头条内容)
- [书源与 OPDS](#书源与-opds)
- [Web UI](#web-ui)
- [管理接口](#管理接口)
- [静态资源](#静态资源)
- [配置说明](#配置说明)
- [示例](#示例)

---

## 概述

yfq-v2 是番茄小说/内容 API 的代理服务，提供书籍、章节、评论、搜索、媒体、漫画等功能的统一访问接口。

**基础信息:**
- 默认端口: 12168
- 协议: HTTP/HTTPS
- 数据格式: JSON（OPDS 为 XML）
- 认证: 管理接口需要 Bearer Token（`YFQ_ADMIN_TOKEN` 环境变量）

---

## 通用说明

### 响应格式

所有 JSON 接口返回统一格式:

```json
{
  "code": 0,
  "message": "",
  "data": { ... }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| code | int | 状态码，0 表示成功 |
| message | string | 错误信息（成功时为空） |
| data | any | 响应数据 |

启用 `fallback.cache_fresh_ttl` 后，短时间内重复的同参数读请求会优先命中本机新鲜缓存，响应不带额外标记；这用于降低 yfq 服务器和上游压力。

当所有数据源都失败且命中最后成功响应缓存时，`data` 中会包含:

| 字段 | 类型 | 说明 |
|------|------|------|
| stale | bool | `true` 表示本次返回的是缓存兜底数据 |
| stale_reason | string | 缓存兜底原因，目前为 `all_sources_failed` |

### 错误码

| HTTP 状态码 | code | 说明 |
|-------------|------|------|
| 200 | 0 | 成功 |
| 400 | 400 | 请求参数错误 |
| 401 | 401 | 未授权（管理接口） |
| 429 | 429 | 上游限流 |
| 502 | 502 | 上游请求失败 |
| 503 | 503 | 服务暂不可用，如管理接口未启用或无可用设备 |
| 504 | 504 | 上游请求超时 |

### 通用查询参数

除 `POST /api/v1/chapters` 外，文档中标注为 `GET` 的 JSON/API 读端点也兼容 `POST`；参数可继续放在 query，也可放在 `application/x-www-form-urlencoded` 或 JSON body 中。静态文件、Web UI 页面仍按浏览器 GET 访问。

| 参数 | 类型 | 说明 |
|------|------|------|
| source | string | 数据源选择: `auto`（默认）或指定单一源。章节源: `content`, `novel`, `toutiao`, `ios`, `web`, `novelfm`；目录源: `web`, `reading`, `novel`；其他接口可指定响应中的 `source` 名称（如 `book_tones`, `related_books`, `chapter_summary`, `audio_detail`, `video_detail`, `author_info`, `author_bookshelf`, `search_hot`, `recommend_homepage`, `rank`） |
| sources / source_order / source_chain | string | 逗号分隔的数据源调度顺序，优先级高于 `source`，如 `web,novel,content` |
| source_mode | string | 调度模式: `auto`/`health`（默认，按健康度动态排序并避开冷却源）, `fixed`/`ordered`（严格按请求或配置顺序） |
| include_novelfm / auto_novelfm | bool | 单章 `source=auto` 时是否把 `novelfm`（aid=3040 3000 章批量接口）加入降级链，默认 `false`（批量接口对单章请求属杀鸡用牛刀）；批量请求 `POST /api/v1/chapters` 与全书下载默认始终首选 novelfm |
| max_retries_per_source / source_retries / retries | int | 本次请求每个数据源最大重试次数，范围 `1-10`，默认使用配置 `chapter.max_retries_per_source` |
| filter / filter_mode / response_filter | string | 响应过滤模式: `default`/`standard`/`yfq` 走标准 yfq API 结构；`custom`/`js` 走自定义 JS；`none`/`raw`/`decrypt`/`decrypted` 直接返回上游已解密 JSON |
| format | string | 内容格式: `plain`（默认）, `html`, `raw` |

> 调度参数仅用于服务端选择数据源，不会透传到上游接口。

自定义 JS 过滤由 `filter.config_path` 指定的 JSON 配置控制，脚本需定义 `filter(data)` 函数，入参为上游已解密 JSON。示例:

```json
{
  "routes": {
    "chapter_content": { "enabled": "custom", "js": "chapter.js" },
    "search": { "enabled": "default", "js": "search.js" }
  }
}
```

---

## 健康检查

### GET /health

服务健康检查。

**响应示例:**
```json
{
  "code": 0,
  "data": {
    "status": "UP",
    "service": "yfq-v2"
  }
}
```

### GET /health/probe

多路由探针检测，默认探测以下路由：detail、chapter_content、toc_reading、search、comments、audio、video、manga。

**查询参数:**

| 参数 | 类型 | 说明 |
|------|------|------|
| routes | string | 逗号分隔的自定义路由列表 |
| book_id | string | 探针用的书籍 ID |
| item_id | string | 探针用的章节 ID |
| query | string | 探针用的搜索词 |

**响应示例:**
```json
{
  "code": 0,
  "data": {
    "probed": [
      {
        "route": "detail",
        "status": "ok",
        "latency": 120,
        "error": "",
        "bytes": 4096
      }
    ]
  }
}
```

### GET /health/sources

返回数据源、设备池、签名类型、缓存和上游 route 的健康快照，用于观察 fallback 与冷却状态。

**响应包含:**
- `metrics`: upstream attempts/failures、fallback successes、fresh/stale cache hits、partial responses
- `cache`: 成功响应缓存是否启用、fresh TTL、兜底 TTL、容量上限
- `pool`: 设备池聚合数量，不包含敏感设备凭据
- `success_rates.sources`: 数据源成功率、冷却状态、冷却截止时间
- `success_rates.sign_types`: 签名类型成功率与冷却状态
- `route_health`: 上游 endpoint 级成功率与冷却状态

---

## 书籍接口

### GET /api/v1/books/{id}

获取书籍详情，自动获取分享/摘录信息。

数据源 fallback 链: `detail` → `multi_detail`（同书多面元数据，含音频/视频/标签）→ `book_share`（分享信息兜底）。响应中的 `source` 字段反映实际命中的数据源。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 书籍 ID |

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| mode | string | `both` | 数据模式: `share`, `both`, `excerpt` |

**响应数据:**

```json
{
  "book_id": "123456",
  "source": "detail",
  "book": {
    "book_id": "123456",
    "book_name": "书名",
    "author": "作者",
    "abstract": "简介",
    "thumb_url": "封面URL",
    "word_number": 100000,
    "genre": "分类",
    "score": "8.5",
    "creation_status": "完结"
  },
  "share": {
    "title": "分享标题",
    "description": "分享描述",
    "url": "分享链接",
    "image": "分享图片"
  },
  "detail": { ... },
  "raw": { ... }
}
```

### GET /api/v1/books/{id}/toc

获取书籍目录（Table of Contents），支持多源降级。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 书籍 ID |

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| source | string | `auto` | 数据源: `auto`, `reading`, `novel`, `web` |

**降级链:** `reading → novel → web`（web 无签名、易被限流，作为最后兜底）

**响应数据:**

```json
{
  "book_id": "123456",
  "source": "web",
  "lists": [
    {
      "index": 1,
      "title": "第一章",
      "item_id": "789",
      "version": 1,
      "word_num": 3000,
      "group_id": "",
      "video_id": ""
    }
  ],
  "total": 100,
  "raw": { ... }
}
```

### GET /api/v1/books/{id}/full.txt

整书下载，流式输出 UTF-8 编码的 TXT 文件。获取目录后并发拉取全部章节内容，按顺序拼接返回。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 书籍 ID |

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| source | string | `auto` | 数据源 |
| format | string | `plain` | 内容格式 |
| concurrency | int | `8` | 并发数（上限 32） |
| max_chapters | int | `5000` | 最大下载章节数 |
| batch_size | int | `1000` | novelfm 批量时每批章节数（上限 3000） |

**响应:**
- Content-Type: `text/plain; charset=utf-8`
- Content-Disposition: `attachment; filename="<书名>.txt"`
- 包含 BOM (`\xef\xbb\xbf`)
- 失败的章节标记为 `[chapter failed: <标题>]`

**示例:**
```bash
curl "http://localhost:12168/api/v1/books/123456/full.txt" -o book.txt
```

### GET /api/v1/books/{id}/author-say

获取作者的话。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 书籍 ID |

**查询参数:** 透传至上游

**响应数据:**
```json
{
  "route": "author_say",
  "source": "author_say",
  "raw": { ... }
}
```

### GET /api/v1/books/{id}/comments

获取书籍评论。该端点等价于 `GET /api/v1/comments`，将路径 `id` 注入 `book_id` 与 `target`，支持全部 8 种评论类型。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 书籍 ID |

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| type | string | `book` | 评论类型，取值同 [GET /api/v1/comments](#get-apiv1comments) 的 8 种类型 |
| count | int | - | 返回数量 |
| offset | string | - | 分页偏移 |

**响应数据:** 同 [GET /api/v1/comments](#get-apiv1comments)

### GET /api/v1/books/{id}/tones

获取书籍朗读音色（TTS tones）。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 书籍 ID |

**响应数据:**

```json
{
  "book_id": "123456",
  "source": "book_tones",
  "raw": { ... }
}
```

### GET /api/v1/books/{id}/related

获取相关作品推荐。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 书籍 ID |

**响应数据:**

```json
{
  "book_id": "123456",
  "source": "related_books",
  "raw": { ... }
}
```

### GET /api/v1/books/{id}/chapters/summary

获取章节摘要。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 书籍 ID |

**查询参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| item_id | string | 是* | 章节 ID（与 `item_ids` 二选一） |
| item_ids | string | 是* | 章节 ID 列表，逗号分隔（与 `item_id` 二选一） |

**响应数据:**

```json
{
  "book_id": "123456",
  "source": "chapter_summary",
  "raw": { ... }
}
```

---

## 章节接口

### GET /api/v1/chapters/{id}

获取单章正文，支持多源自动降级。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 章节 ID（item_id） |

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| item_id | string | - | 章节 ID（备选，与路径参数二选一） |
| book_id | string | - | 书籍 ID |
| source | string | `auto` | 数据源: `auto`, `content`, `novel`, `toutiao`, `ios`, `web`, `novelfm` |
| format | string | `plain` | 内容格式: `plain`, `html`, `raw` |

**降级链（auto 模式）:** `novelfm → content → novel → ios → batch_full → toutiao → web`

> 单章 `source=auto` 自动过滤 `batch_full` 和 `novelfm` 批量接口，实际单章降级链为 `content → novel → ios → toutiao → web`。
> `toutiao`（aid=13 单章 DH）稳定无缺字，排在 `batch_full` 之后作为兜底单章源。
> `novelfm`（aid=3040 3000 章批量 DH）稳定可靠，是批量请求与全书下载的默认首选；单章请求需 `include_novelfm=true` 或显式 `source=novelfm` 启用。

**响应数据:**

```json
{
  "item_id": "789",
  "book_id": "123456",
  "source": "content",
  "format": "plain",
  "title": "第一章 标题",
  "content": "章节内容...",
  "word_num": 3000,
  "version": 1,
  "chapter": { ... },
  "raw": { ... }
}
```

### POST /api/v1/chapters

批量获取章节内容（novelfm DH 加密通道 / batch_full / toutiao 单章）。

**请求体（JSON 或 form-data）:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| book_id | string | 否 | 书籍 ID |
| item_ids | string | 是 | 章节 ID 列表，逗号分隔 |
| source | string | `auto` | 数据源 |
| format | string | `plain` | 内容格式 |

> `source=auto` 时默认首选 `novelfm`（aid=3040 3000 章 DH，稳定可靠）。`item_ids` 最多 300 个（`source=novelfm` 或 auto 时最多 3000 个）。`batch_full` 上游硬限 30 章/请求，超出自动分块合并；`toutiao` 为单章接口，批量请求时按 1 章/请求分块。批量源整体失败或缺少部分章节时，服务会自动逐章 fallback 补齐；只要至少一章成功就返回 200。

**响应数据:**

```json
{
  "book_id": "123456",
  "item_ids": ["123", "456", "789"],
  "source": "novelfm",
  "partial": false,
  "chapters": [
    {
      "item_id": "123",
      "title": "第一章",
      "content": "...",
      "format": "plain",
      "word_num": 3000
    }
  ],
  "failed": [],
  "raw": { ... }
}
```

当部分章节仍失败时：

```json
{
  "partial": true,
  "chapters": [{ "item_id": "123", "content": "..." }],
  "failed": [
    { "item_id": "456", "error": "upstream request failed" }
  ]
}
```

### GET /api/v1/chapters/{id}/comments

获取章节/段落评论。该端点等价于 `GET /api/v1/comments`，将路径 `id` 注入 `item_id` 与 `target`，支持全部 8 种评论类型。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 章节 ID |

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| type | string | `para` | 评论类型，取值同 [GET /api/v1/comments](#get-apiv1comments) 的 8 种类型 |
| book_id | string | - | 章末评论与段评上游需要 `book_id` 解析 `forum_id` |
| para_index | int | `0` | 段评段落索引（`type=para` 时使用） |
| count | int | - | 返回数量 |
| offset | string | - | 分页偏移 |

**响应数据:** 同 [GET /api/v1/comments](#get-apiv1comments)

### GET /api/v1/chapters/{id}/manga

获取漫画内容，自动解密图片并存储到本地。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 漫画章节 ID（item_id） |

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| show_html | string | - | 设为 `1` 返回 HTML 格式 |

**响应数据:**

```json
{
  "item_id": "123",
  "manga": { ... },
  "manifest": { ... },
  "raw": { ... }
}
```

### GET /api/v1/chapters/{id}/comment-count

获取章节段评（段落评论）数量统计。上游为 `POST novel/commentapi/idea/list/{item_id}/v1`（签名接口，body 含 `comment_source=3` 与 `item_id`），返回该章节下所有段落评论的气泡数量。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 章节 ID（item_id） |

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| item_id | string | - | 章节 ID（备选，与路径参数二选一） |
| item_ids | string | - | 章节 ID（再备选，兼容批量场景首项） |
| source | string | `auto` | 数据源，目前固定 `comment_count` |

**响应数据:**

```json
{
  "source": "comment_count",
  "raw": {
    "code": 0,
    "data": {
      "data": {
        "0": { "count": 530 }
      }
    }
  }
}
```

> `raw.data.data["0"].count` 为段评总数；当某段落无评论时上游不返回对应键。

### GET /api/v1/chapters/info

获取章节元信息（公开 API，无需签名）。上游为 `GET novel.snssdk.com/api/novel/book/directory/detail/v/?aid=1319&item_ids=...`，支持按 `item_ids` 批量查询章节的标题、摘要、字数、作者、封面等元数据。

**查询参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| item_ids | string | 是* | 章节 ID 列表，逗号分隔（与 `item_id` 二选一） |
| item_id | string | 是* | 单个章节 ID（与 `item_ids` 二选一，会被规范化为 `item_ids`） |
| source | string | `auto` | 数据源，目前固定 `item_info` |

> 该接口与 `GET /api/v1/books/{id}/toc`（`/directory/list/v1` aid=13 签名）是不同上游路径：本接口面向**章节元信息**批量查询，TOC 面向**单书目录**列表。本接口不接受 `book_id` 参数。

**响应数据:**

```json
{
  "source": "item_info",
  "raw": {
    "code": 0,
    "data": [
      {
        "item_id": "7094822014900240933",
        "title": "第一章 标题",
        "abstract": "章节摘要...",
        "word_number": 3000,
        "author": "作者名",
        "thumb_url": "封面URL"
      }
    ]
  }
}
```

**示例:**

```bash
# 单个章节
curl "http://localhost:12168/api/v1/chapters/info?item_id=7094822014900240933"

# 多个章节批量
curl "http://localhost:12168/api/v1/chapters/info?item_ids=7094822014900240933,7094822014900240934"
```

---

## 评论接口

### GET /api/v1/comments

统一评论 API，支持 8 种评论类型。每种类型严格只调用对应的专属上游路由，不做跨类型 fallback（书评用 `group_type=1`+`book_id`，段评用 `group_type=15`+`item_id`，参数语义不同，跨类型调用会导致上游返回错误数据或 `PARAM_INVALID`）。

**查询参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| target | string | 是* | 目标 ID（与 `book_id` 二选一） |
| book_id | string | 是* | 书籍 ID（与 `target` 二选一） |
| type | string | `book` | 评论类型 |
| count | int | - | 返回数量 |
| offset | string | - | 分页偏移 |

**评论类型（type）与对应上游路由:**

| 类型 | 说明 | 上游路由 |
|------|------|---------|
| `book` | 书评 | `comments` |
| `book_reply` | 书评回复 | `comments_reply` |
| `book_reply_reply` | 书评二级回复 | `comments_reply_reply` |
| `end` | 章末评论 | `end_comments` |
| `end_reply` | 章末评论回复 | `end_comments_reply` |
| `end_reply_reply` | 章末评论二级回复 | `end_comments_reply_reply` |
| `para` | 段落评论 | `chapter_comments` |
| `para_reply` | 段落评论回复 | `comment_replies` |

**响应数据:**

```json
{
  "type": "book",
  "source": "comments",
  "comments": [
    {
      "id": "123",
      "user_id": "456",
      "user": "用户名",
      "content": "评论内容",
      "ctime": "2024-01-01 12:00:00",
      "digg_num": 100
    }
  ],
  "total": 100,
  "cursor": "next_cursor",
  "raw": { ... }
}
```

---

## 搜索接口

### GET /api/v1/search

搜索书籍/音频/漫画/连载。

**查询参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query / kw | string | 是 | 搜索关键词 |
| search_type | string | - | 搜索类型: `default`（默认）, `fanqie` |
| tab_type | string | - | 标签页类型，按内容分类过滤 search_tabs 结果（见下表） |
| offset | string | - | 分页偏移 |

> `search_type=fanqie` 使用番茄专用搜索通道；默认通道失败时自动回退到 fanqie。
>
> `tab_type` 用于按内容分类精确过滤搜索结果。上游 `search_tabs` 一次返回所有标签页，但只有请求的 `tab_type` 对应的标签页有 `data`，其余为 `null`。服务端会从对应标签页抽取书籍列表；短剧（tab_type=11）的单元格结构特殊（`book_id` 在顶层，书名/封面在 `video_data[0]`），服务端会自动归一化为统一的 `book` 结构。支持中文别名与原始数字 ID：

| tab_type | 数字 ID | 说明 |
|----------|---------|------|
| 综合 | 1 | 默认综合搜索 |
| 听书 | 2 | 有声书 |
| 书籍 | 3 | 小说（默认书籍） |
| 社区 | 4 | 社区内容 |
| 全文 | 5 | 全文搜索 |
| 用户 | 6 | 用户 |
| 漫画 | 8 | 漫画 |
| 短剧 | 11 | 短剧（单元格走 `video_data` 归一化） |
| 买书 | 13 | 买书 |
| 漫剧 | 19 | 漫剧 |

**示例:**

```bash
# 搜索短剧
curl "http://localhost:12168/api/v1/search?query=庆余年&tab_type=11"
# 等价于
curl "http://localhost:12168/api/v1/search?query=庆余年&tab_type=短剧"

# 搜索听书
curl "http://localhost:12168/api/v1/search?query=斗罗大陆&tab_type=听书"

# 搜索漫画
curl "http://localhost:12168/api/v1/search?query=一人之下&tab_type=漫画"
```

**响应数据:**

```json
{
  "query": "斗破苍穹",
  "source": "default",
  "books": [
    {
      "book_id": "123",
      "book_name": "书名",
      "author": "作者",
      "abstract": "简介",
      "thumb_url": "封面URL"
    }
  ],
  "total": 10,
  "has_more": false,
  "search_id": "xxx",
  "raw": { ... }
}
```

### GET /api/v1/search/suggest

搜索预测/建议。

**查询参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| keyword / query | string | 是 | 搜索关键词 |

**响应数据:**

```json
{
  "keyword": "斗",
  "source": "search_suggest",
  "raw": { ... }
}
```

### GET /api/v1/categories

获取发现页分类（简单签名接口）。

**查询参数:** 透传至上游

**响应数据:**
```json
{
  "route": "categories",
  "source": "categories",
  "raw": { ... }
}
```

### GET /api/v1/landing

获取分类落地页（简单签名接口）。

**查询参数:** 透传至上游

**响应数据:**
```json
{
  "route": "landing",
  "source": "landing",
  "raw": { ... }
}
```

### GET /api/v1/search/hot

获取热搜榜。

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| offset | string | - | 分页偏移 |
| scene | int | `10` | 场景参数 |

**响应数据:**

```json
{
  "route": "search_hot",
  "source": "search_hot",
  "raw": { ... }
}
```

### GET /api/v1/recommend/homepage

获取首页推荐（书城 Tab）。

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| tab_type | int | `2` | 标签页类型 |
| offset | string | - | 分页偏移 |

**响应数据:**

```json
{
  "route": "recommend_homepage",
  "source": "recommend_homepage",
  "raw": { ... }
}
```

### GET /api/v1/rank/{id}

获取排行榜（书城单元格）。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 单元格 ID（cell_id） |

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| offset | string | - | 分页偏移 |
| list_type | string | `daily` | 榜单类型 |
| limit | int | `12` | 返回数量 |

**响应数据:**

```json
{
  "rank_id": "...",
  "source": "rank",
  "raw": { ... }
}
```

---

## 媒体接口

### GET /api/v1/media/{type}

获取音视频/TTS/短剧媒体信息。支持同类型降级：`audio → audio_novelfm → tts`（听书主路由失败时先尝试番茄畅听 novelfm 端点，仍失败再降级到 TTS）、`video → pseries`（短剧剧集不可用时降级到系列源）。发生降级时响应中包含 `fallback` 指示字段，前端可据此调整 UI 提示。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| type | string | 是 | 媒体类型: `audio`, `video`, `tts`, `pseries` |

**查询参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| item_id | string | 是 | 内容项 ID |
| book_id | string | 否 | 书籍 ID（`audio` 路由在 `tone_id` 无效时会自动获取该书的有效音色重试） |
| tone_id | string | 否 | TTS 音色 ID |
| quality | string | `high` | 质量: `low`, `high` |

**降级链:**
- `audio`: `audio → audio_novelfm → tts`
  - `audio`：aid=1967 `reading/reader/audio/playinfo`（com.dragon.read，原有路由，部分书籍返回空/加密 URL）
  - `audio_novelfm`：aid=3040 `novelfm/playerapi/video_model/mget/v1`（com.xs.fm 番茄畅听，App 音频播放器使用的源），自动处理 `fallback_api` 降级链与 spade 加密 URL（AES-128-CBC + SHA-512 派生密钥）解密，覆盖原路由失败的大部分书籍
  - `tts`：TTS 朗读，最后兜底
- `video`: `video → pseries`
- `tts` / `pseries`: 仅调用对应路由，无降级

**响应数据:**

```json
{
  "type": "video",
  "source": "video",
  "play": {
    "quality": "high",
    "play_url": "https://...",
    "proxy_url": "http://host/api/v1/videos/proxy?url=...",
    "cek": "...",
    "decrypt_url": "http://host/api/v1/videos/decrypt?url=...&key=..."
  },
  "fallback": true,
  "fallback_from": "video",
  "fallback_to": "pseries",
  "raw": { ... }
}
```

> `fallback` / `fallback_from` / `fallback_to` 三个字段仅在发生降级时出现；未降级时省略。

### GET /api/v1/videos/proxy

代理播放视频 URL，支持 Range 请求。

**查询参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 视频 URL |

**响应:** 视频流（代理转发）

> 限制最大代理体积由 `media.video_proxy_max_size` 控制（默认 500MB）。

### GET /api/v1/videos/decrypt

解密 CENC 加密视频（需要 ffmpeg）。

**查询参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string | 是 | 加密视频 URL |
| key | string | 否* | 解密密钥（hex 字符串） |
| spade_a | string | 否* | spade_a 混淆数据（用于自动提取密钥） |

> `key` 和 `spade_a` 二选一。

**响应:** 解密后的视频流（`video/mp4`）

> 需要服务器安装 `ffmpeg` 并加入 PATH。

### GET /api/v1/audio/books/{id}

获取有声书详情。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 书籍 ID |

**响应数据:**

```json
{
  "book_id": "123456",
  "source": "audio_detail",
  "raw": { ... }
}
```

### GET /api/v1/videos/{id}

获取视频剧集详情。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 视频/剧集 ID |

**响应数据:**

```json
{
  "video_id": "...",
  "source": "video_detail",
  "raw": { ... }
}
```

---

## 作者接口

### GET /api/v1/authors/{id}

获取作者信息。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 作者 user_id |

**响应数据:**

```json
{
  "author_id": "...",
  "source": "author_info",
  "raw": { ... }
}
```

### GET /api/v1/authors/{id}/bookshelf

获取作者书架。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 作者 user_id |

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| count | int | `30` | 返回数量 |
| offset | int | `0` | 分页偏移 |

**响应数据:**

```json
{
  "author_id": "...",
  "source": "author_bookshelf",
  "raw": { ... }
}
```

---

## 头条内容

### GET /api/v1/articles/{id}

获取头条文章。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 文章 ID（item_id） |

**查询参数:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| format | string | `plain` | 内容格式 |

**响应数据:**

```json
{
  "type": "article",
  "item_id": "123",
  "source": "toutiao_article",
  "format": "plain",
  "title": "文章标题",
  "content": "文章内容...",
  "word_num": 3000,
  "raw": { ... }
}
```

### GET /api/v1/novels/{id}

获取头条小说详情。

**路径参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 帖子 ID（post_id） |

**查询参数:** 透传至上游

**响应数据:**
```json
{
  "route": "novel_detail",
  "source": "novel_detail",
  "raw": { ... }
}
```

---

## 书源与 OPDS

### GET /api/v1/book-sources

获取 Legado 书源配置。

**查询参数:**

| 参数 | 类型 | 说明 |
|------|------|------|
| format | string | 设为 `download` 时直接下载单个书源文件 |

**响应数据:**

```json
[
  {
    "bookSourceName": "...",
    "bookSourceUrl": "...",
    ...
  }
]
```

> 书源模板位于 `booksource/` 目录，`{{host}}` 占位符会被替换为当前服务地址。

### GET /api/v1/opds

OPDS 目录导航（XML 格式）。

**响应:** OPDS Atom XML

```xml
<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <title>yfq-v2 OPDS</title>
  <entry>
    <title>搜索书籍</title>
    <link rel="subsection" href="/api/v1/opds/search?q=" />
  </entry>
</feed>
```

### GET /api/v1/opds/search

OPDS 搜索。

**查询参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| q / query / key | string | 是 | 搜索关键词 |

**响应:** OPDS Atom XML，包含搜索结果条目

---

## Web UI

### GET /reader/novel

小说阅读器页面（HTML）。

**查询参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| item_id | string | 是 | 章节 ID |
| book_id | string | 否 | 书籍 ID |
| title | string | 否 | 页面标题，默认 "小说阅读" |

**响应:** HTML 页面

### GET /reader/manga

漫画阅读器页面（HTML）。

**查询参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| item_id | string | 是 | 漫画章节 ID |
| book_id | string | 否 | 书籍 ID |
| title | string | 否 | 页面标题，默认 "漫画阅读" |

**响应:** HTML 页面

### GET /player

短剧播放器页面（HTML）。

**查询参数:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| item_id | string | 是 | 短剧 ID |
| book_id | string | 否 | 书籍 ID |
| title | string | 否 | 页面标题，默认 "短剧播放" |

**响应:** HTML 页面

---

## 管理接口

> 管理接口要求设置 `YFQ_ADMIN_TOKEN` 环境变量，请求时携带 `Authorization: Bearer <token>`。
> 若未设置 `YFQ_ADMIN_TOKEN`，管理接口返回 503。

### GET /admin/device/pool

获取设备池状态、签名健康度、成功率统计。

**请求头:**
```
Authorization: Bearer <token>
```

**响应数据:**

```json
{
  "code": 0,
  "data": {
    "pool": {
      "total": 50,
      "active": 20,
      "standby": 15,
      "cooldown": 15
    },
    "sign_health": { ... },
    "route_health": { ... },
    "success_rates": {
      "sources": { ... },
      "devices": { ... }
    }
  }
}
```

### POST /admin/device/register

手动注册新设备。

**请求头:**
```
Authorization: Bearer <token>
```

**请求参数（Query 或 JSON Body）:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| count | int | `1` | 注册数量（上限 100） |
| mode | string | - | 设为 `local` 仅本地生成 |
| platform | string | `android` | 平台: `android`, `ios` |

**响应数据:**

```json
{
  "code": 0,
  "data": {
    "registered": 5,
    "errors": [],
    "stats": {
      "total": 55,
      "active": 25,
      "standby": 15,
      "cooldown": 15
    }
  }
}
```

### POST /admin/device/refill

补充设备池至目标数量。

**请求头:**
```
Authorization: Bearer <token>
```

**请求参数（Query 或 JSON Body）:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| target | int | `min_active + min_standby` | 目标设备总数 |
| mode | string | - | 设为 `local` 仅本地生成 |
| platform | string | `android` | 平台: `android`, `ios` |

> `target` 上限为 `max_active + min_standby + 100`。

**响应数据:**

```json
{
  "code": 0,
  "data": {
    "registered": 10,
    "errors": [],
    "stats": { ... }
  }
}
```

---

## 静态资源

### GET /static/img/{path}

漫画图片静态服务。漫画解密后的图片存储在 `manga.storage_dir`（默认 `static/img`），通过此路径访问。

### GET /

Web 首页模板。从 `web.template_dir`（默认 `data/web`）加载 `index.html` 并提供静态文件服务。

---

## 配置说明

主要配置项（通过 `config.yaml` 或环境变量）:

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `server.port` | `12168` | 服务端口 |
| `server.read_timeout` | `10s` | 读超时 |
| `server.write_timeout` | `30s` | 写超时 |
| `pool.min_active` | `20` | 最小活跃设备数 |
| `pool.max_active` | `200` | 最大活跃设备数 |
| `pool.standby_ratio` | `0.15` | 备用比例 |
| `pool.min_standby` | `10` | 最小备用设备数 |
| `pool.register_rate` | `5` | 每分钟注册速率 |
| `pool.emergency_rate` | `10` | 紧急注册速率 |
| `pool.default_qps` | `3.0` | 单设备 QPS 上限 |
| `pool.fail_threshold` | `3` | 失败退役阈值 |
| `pool.fail_cooldown` | `10m` | 失败冷却时间 |
| `device_pool.file` | `data/device_pool.json` | 设备池持久化文件 |
| `device_pool.save_interval` | `30s` | 持久化间隔 |
| `device_pool.backup_count` | `3` | 备份轮转数 |
| `upstream.timeout` | `8s` | 上游请求超时 |
| `upstream.max_idle_conns` | `200` | 最大空闲连接 |
| `upstream.idle_conn_timeout` | `90s` | 空闲连接超时 |
| `upstream.user_agent` | `com.dragon.read` | 上游请求 UA |
| `fallback.cache_enabled` | `true` | 是否启用成功响应缓存 |
| `fallback.cache_fresh_ttl` | `30s` | 短期新鲜缓存时间，命中时直接返回以减少重复上游请求；设为 `0s` 可关闭 |
| `fallback.cache_ttl` | `10m` | 成功响应缓存兜底有效期，全源失败时可返回并标记 `stale` |
| `fallback.cache_max_size` | `1024` | 成功响应缓存最大条目数 |
| `filter.config_path` | `data/filter.json` | 自定义 JS 过滤配置路径，不存在时所有路由使用标准 yfq API 过滤 |
| `chapter.fallback_chain` | `[novelfm, content, novel, ios, batch_full, toutiao, web]` | 章节降级链；`novelfm`（3000 章批量 DH）稳定可靠，批量/下载默认首选；`toutiao`（单章 DH）排在 `batch_full` 之后；单章 auto 自动过滤 `batch_full`/`novelfm` |
| `chapter.max_retries_per_source` | `1` | 每源最大重试；底层已做设备轮换，默认避免重复放大压力 |
| `chapter.default_format` | `plain` | 默认正文格式 |
| `chapter.batch.max_items` | `300` | 批量最大章节数 |
| `download.max_chapters` | `5000` | 整书下载最大章节数 |
| `download.default_concurrency` | `8` | 下载默认并发 |
| `download.chapter_timeout` | `30s` | 单章下载超时 |
| `manga.storage_dir` | `static/img` | 漫画图片存储目录 |
| `manga.max_images` | `100` | 单次最大图片数 |
| `manga.max_image_size` | `12MB` | 单图片大小限制 |
| `manga.cleanup_after` | `2m` | 图片清理间隔 |
| `media.video_proxy_max_size` | `500MB` | 视频代理大小限制 |
| `media.default_quality` | `high` | 默认媒体质量 |
| `watermark.enabled` | `false` | 是否启用正文水印 |
| `watermark.text` | `""` | 水印文本 |
| `watermark.charset` | `""` | 水印字符集 |
| `log.level` | `info` | 日志级别 |
| `log.format` | `json` | 日志格式 |
| `log.output` | `stdout` | 日志输出 |
| `web.template_dir` | `data/web` | Web 模板目录 |

---

## 示例

### 搜索书籍
```bash
curl "http://localhost:12168/api/v1/search?query=斗破苍穹"
```

### 获取书籍详情
```bash
curl "http://localhost:12168/api/v1/books/123456"
```

### 获取章节目录
```bash
curl "http://localhost:12168/api/v1/books/123456/toc"
```

### 获取单章内容
```bash
curl "http://localhost:12168/api/v1/chapters/789?format=plain"
```

### 批量获取章节
```bash
curl -X POST "http://localhost:12168/api/v1/chapters" \
  -H "Content-Type: application/json" \
  -d '{"book_id": "123456", "item_ids": "123,456,789"}'
```

### 稳定性压测
```bash
wrk -t4 -c100 -d5m -s scripts/stability.lua http://127.0.0.1:12168
```

### 整书下载
```bash
curl "http://localhost:12168/api/v1/books/123456/full.txt" -o book.txt
```

### 获取评论
```bash
curl "http://localhost:12168/api/v1/comments?book_id=123456&type=book"
```

### 获取媒体
```bash
curl "http://localhost:12168/api/v1/media/video?item_id=123"
```

### 管理设备池
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://localhost:12168/admin/device/pool"
```

### 注册设备
```bash
curl -X POST -H "Authorization: Bearer YOUR_TOKEN" \
  "http://localhost:12168/admin/device/register?count=5&platform=android"
```
