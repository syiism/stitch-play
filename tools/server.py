#!/usr/bin/env python3
"""server.py · 静态文件 + 数据源同源代理

替代 `python3 -m http.server`：
  - /                → 工程根目录静态文件（页面与示例视频），自动定位，与解压/启动位置无关
  - /<prefix>/*      → 反向代理到 config.json / config.example.json 中 proxies 指定的 upstream/*
                      （如 /mf/* → http://接口地址/*；mufan API 无 CORS 头，浏览器需同源转发）
                        支持 Range 透传（视频拖进度条）
  - 代理前缀与上游地址只从配置读取，禁止硬编码

用法：python3 tools/server.py [port] [root]
      port  默认 8099
      root  默认工程根目录（tools/ 的上一级），一般无需指定
"""
import copy
import json
import os
import sys
import urllib.request
import urllib.error
from urllib.parse import quote
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PASS_HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Cache-Control")
CHUNK = 64 * 1024
RESUME_TRIES = 8  # 上游取流偶发提前断连，用 Range 续传补齐的最大次数
# 路径规范化时保持原样的字符：URL 保留字 + 已有的 %XX 编码 + 查询串常见符号（含字面 +）
URL_SAFE = "/?&=+-._~:@!$'()*,;%"

# 服务根目录 = 本文件（tools/server.py）的上一级，即工程根；不写死绝对路径，本机解压到哪都能跑
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_config(root):
    """读取指定服务根目录下的数据源/代理配置。优先 config.json，缺失时回退 config.example.json。
    环境变量可覆盖上游地址（如 STITCH_UPSTREAM_MF=...），真实接口地址可完全不入文件。"""
    cfg = None
    path = None
    for name in ("config.json", "config.example.json"):
        p = os.path.join(root, name)
        if os.path.isfile(p):
            try:
                with open(p, encoding="utf-8") as f:
                    cfg, path = json.load(f), p
                break
            except json.JSONDecodeError as e:
                print(f"[srv] 配置 {p} 解析失败：{e}；跳过该文件", file=sys.stderr)
    if cfg is None:
        # 无任何配置文件：用 BUILTIN_CONFIG 作为兜底，保证 sources[].proxy / proxies[]
        # 的占位条目齐全，STITCH_UPSTREAM_<PREFIX> 环境变量即可注入对应 upstream。
        cfg = copy.deepcopy(BUILTIN_CONFIG)
        # 兜底配置只用于服务端内部路由表；把可能的上游占位符清掉，避免误当作有效地址
        for pr in cfg.get("proxies", []):
            pr.pop("upstream", None)
        path = None
    # 环境变量注入真实上游：STITCH_UPSTREAM_<PREFIX>（避免接口地址写死在配置/仓库）
    proxies = cfg.setdefault("proxies", [])
    # —— 补齐占位：从 sources[].proxy 自动产生前缀条目，保证即使 proxies 数组为空/缺项，
    #    对应 STITCH_UPSTREAM_<PREFIX> 环境变量仍能注入。（两源拆前缀 mfs/mfm 后尤其重要）
    existing_prefixes = {str(p.get("prefix", "")).strip() for p in proxies if isinstance(p, dict)}
    for s in cfg.get("sources", []) or []:
        pf = str((s or {}).get("proxy", "") or "").strip()
        if pf and pf not in existing_prefixes:
            proxies.append({"prefix": pf})
            existing_prefixes.add(pf)
    for pr in proxies:
        prefix = str(pr.get("prefix", "")).strip()
        env_key = f"STITCH_UPSTREAM_{prefix.upper()}"
        if env_key in os.environ and os.environ[env_key].strip():
            pr["upstream"] = os.environ[env_key].strip()
    return cfg, path


def build_proxy_table(cfg):
    """代理路由表：prefix -> upstream（去掉末尾斜杠；仅来自配置）"""
    table = {}
    for p in (cfg or {}).get("proxies", []):
        prefix = str(p.get("prefix", "")).strip("/")
        upstream = str(p.get("upstream", "")).strip("/")
        if prefix and upstream:
            table[prefix] = upstream
    return table


# 前端内置兜底配置（与 src/runtimeConfig.js 的 DEFAULT 一致）：
# 供 /config.json 在 → config.json → config.example.json 均缺失时返回，保证该路由恒有有效内容。
BUILTIN_CONFIG = {
    # proxies 占位：prefix 存在即可被环境变量 STITCH_UPSTREAM_<PREFIX> 注入真实 upstream
    "proxies": [{"prefix": "mfs"}, {"prefix": "mfm"}, {"prefix": "mf"}],
    "sources": [
        {"id": "mufan-short", "label": "沐凡 · 短剧", "category": "short", "mode": "mufan", "proxy": "mfs"},
        {"id": "mufan-manju", "label": "沐凡 · 漫剧", "category": "manju", "mode": "mufan", "proxy": "mfm"},
    ],
    "mufan_api": {
        "discover": "/api/bookmall/cell/change",
        "search": "/api/search",
        "directory": "/api/directory",
        "video": "/api/video",
    },
    "tabs": {
        "short": {"genre_tab": 4, "search_tab": 11},
        "manju": {"genre_tab": 5, "search_tab": 19},
    },
    "request": {"timeout_ms": 45000},
}


CFG, CFG_PATH = load_config(ROOT_DIR)
PROXY_TABLE = build_proxy_table(CFG)
PROXY_PREFIXES = sorted(PROXY_TABLE.keys(), key=len, reverse=True)


def upstream_for(path):
    """返回 (upstream, 剩余路径) 若命中某代理前缀，否则 None。"""
    for prefix in PROXY_PREFIXES:
        if path == "/" + prefix or path.startswith("/" + prefix + "/"):
            return PROXY_TABLE[prefix], path[len(prefix) + 1:]
    return None


def normalize_path(path):
    """把请求路径规范化为合法的 ASCII URL（百分号编码）。
    部分客户端/中间层会把非 ASCII 字符（如中文搜索词）以原始 UTF-8 字节写进请求行，
    http.server 按 Latin-1 解码后得到乱码文本，直接拼进上游 URL 会触发
    UnicodeEncodeError（浏览器侧表现为 502 空响应）。这里统一还原请求行原始字节并
    重新百分号编码；已是正常 %XX 编码的路径不受影响（% 在安全字符集中原样保留）。"""
    try:
        raw = path.encode("latin-1")  # 还原请求行上的原始字节
    except UnicodeEncodeError:
        return quote(path, safe=URL_SAFE)  # 已是真正 Unicode 字符 → 按 UTF-8 编码
    return quote(raw, safe=URL_SAFE)


class ClientGone(Exception):
    """浏览器中断了连接（切集、划走、关页面都很常见）：不必续传也不必报错。"""


def body_start(resp):
    """响应体首字节在整个资源中的偏移：206 从 `Content-Range: bytes X-Y/Z` 取 X，其余为 0。"""
    head = (resp.headers.get("Content-Range") or "").replace("bytes", "").strip().split("-", 1)[0].strip()
    return int(head) if head.isdigit() else 0


class Handler(SimpleHTTPRequestHandler):
    _proxying = False  # 代理响应沿用上游缓存头，不叠加本地 no-store

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def end_headers(self):
        # 页面/JS/CSS/JSON 一律 no-store：开发期文件频繁变更，避免浏览器缓存旧模块导致功能不生效
        if not self._proxying:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # —— 数据源同源代理（前缀路由来自配置） ——
    def _serve_client_config(self, name):
        """下发浏览器端配置（剥离 upstream）。
        /config.json：前端唯一入口。按 config.json → config.example.json → 内置 BUILTIN_CONFIG
        取「最有效」配置返回，保证该路由恒有有效内容，前端只发一次请求即可拿到完整配置。
        /config.example.json：兼容旧直链，仅精确返回示例文件；缺失则 404。"""
        if name == "/config.json":
            cfg = self._effective_client_config()
        else:
            path = os.path.join(ROOT_DIR, name.lstrip("/"))
            if not os.path.isfile(path):
                return self.send_error(404)
            with open(path, encoding="utf-8") as f:
                cfg = json.load(f)
        for p in cfg.get("proxies", []):
            if isinstance(p, dict):
                p.pop("upstream", None)  # 前端只要代理前缀，不需要真实上游地址
        data = json.dumps(cfg, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _effective_client_config(self):
        """按 config.json → config.example.json → 内置 BUILTIN_CONFIG 取有效配置（深拷贝，不污染全局）。"""
        for candidate in ("config.json", "config.example.json"):
            p = os.path.join(ROOT_DIR, candidate)
            if not os.path.isfile(p):
                continue
            try:
                with open(p, encoding="utf-8") as f:
                    cfg = json.load(f)
                if isinstance(cfg, dict) and isinstance(cfg.get("sources"), list):
                    return cfg
                print(f"[srv] 配置 {p} 缺少 sources，跳过", file=sys.stderr)
            except json.JSONDecodeError as e:
                print(f"[srv] 配置 {p} 解析失败：{e}；跳过", file=sys.stderr)
        return copy.deepcopy(BUILTIN_CONFIG)

    def _pump(self, resp, limit=None):
        """转发上游响应体，返回实际转发的字节数。
        注意：http.client 在 read(amt) 时对「提前 EOF」不抛 IncompleteRead（只返回 b""），
        所以是否收齐必须由调用方拿字节数与 Content-Length 核对。"""
        n = 0
        while limit is None or n < limit:
            chunk = resp.read(CHUNK if limit is None else min(CHUNK, limit - n))
            if not chunk:
                break
            try:
                self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError) as e:
                raise ClientGone from e
            n += len(chunk)
        return n

    def _proxy(self, upstream, rest_path):
        self._proxying = True
        target = upstream + normalize_path(rest_path)  # 非 ASCII 路径规范化（防 UnicodeEncodeError → 502）
        req = urllib.request.Request(target, method=self.command)
        rng = self.headers.get("Range")
        # 上游取流接口的 Range 分支吞吐只有 ~40KB/s（不带 Range 的全量 GET 约 684KB/s），
        # 而浏览器起播固定发 `Range: bytes=0-`（语义上等于整段）。原样转发会让下载速度低于
        # 视频码率，导致永久缓冲、canplay 不触发。所以「从 0 开始的开放区间」不转发，
        # 让上游走快的全量分支返回 200；真实拖动进度条产生的区间 Range 仍照常转发。
        drop_range = bool(rng) and rng.replace(" ", "") == "bytes=0-"
        if rng and not drop_range:
            req.add_header("Range", rng)
        accept = self.headers.get("Accept")
        if accept:
            req.add_header("Accept", accept)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                self.send_response(resp.status)
                for h in PASS_HEADERS:
                    v = resp.headers.get(h)
                    if v:
                        self.send_header(h, v)
                if drop_range and not resp.headers.get("Accept-Ranges"):
                    self.send_header("Accept-Ranges", "bytes")  # 保留浏览器 seek 能力
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                if self.command == "HEAD":
                    return
                want = int(resp.headers.get("Content-Length") or 0)
                start = body_start(resp)  # 本次响应体首字节在整个资源中的偏移
                got = self._pump(resp, want or None)
            # 上游取流会在吐出部分字节后直接关连接（实测声明 17,328,821 字节、只给
            # 1,441,895 字节；同一地址重取则完整）。Content-Length 已按上游声明下发，
            # 少给字节浏览器立刻 ERR_CONTENT_LENGTH_MISMATCH 并让 <video> 触发 error。
            # 上游支持区间 Range 且这条路径吞吐正常（实测 15.5MB / 20s），用续传补齐缺口。
            tries = 0
            while want and got < want and tries < RESUME_TRIES:
                tries += 1
                more = urllib.request.Request(target, method="GET")
                more.add_header("Range", f"bytes={start + got}-{start + want - 1}")
                try:
                    with urllib.request.urlopen(more, timeout=60) as resp2:
                        if resp2.status != 206:
                            break  # 上游忽略了 Range，再读会把开头重复写进去
                        got += self._pump(resp2, want - got)
                except ClientGone:
                    raise
                except Exception as e:  # noqa: BLE001 续传本身也可能断，预算内继续试
                    self.log_error("proxy resume#%d %s -> %s", tries, self.path.split("?", 1)[0], e)
        except ClientGone:
            return  # 浏览器不要了，直接收工
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(e.read()[:4096])
        except Exception as e:  # noqa: BLE001
            self.log_error("proxy %s -> %s", self.path, e)
            self.send_response(502)
            self.end_headers()

    def do_GET(self):
        hit = upstream_for(self.path)
        if hit:
            upstream, rest = hit
            return self._proxy(upstream, rest)
        # 浏览器端配置：剥离 upstream 后下发（接口地址不离开服务端）
        clean = self.path.split("?", 1)[0]
        if clean in ("/config.json", "/config.example.json"):
            return self._serve_client_config(clean)
        return super().do_GET()

    def do_HEAD(self):
        hit = upstream_for(self.path)
        if hit:
            upstream, rest = hit
            return self._proxy(upstream, rest)
        clean = self.path.split("?", 1)[0]
        if clean in ("/config.json", "/config.example.json"):
            return self._serve_client_config(clean)
        return super().do_HEAD()

    def log_message(self, fmt, *args):  # 精简日志
        for prefix in PROXY_PREFIXES:
            if "/" + prefix + "/" in (args[0] if args else ""):
                return  # 视频流请求不打日志，避免刷屏
            if args and args[0].startswith("/" + prefix + "?"):
                return
        sys.stderr.write("[srv] " + (fmt % args) + "\n")

    def log_error(self, fmt, *args):
        # 错误必须可见：绕过 log_message 的 /mf/ 静音规则（否则代理 502 无迹可查）
        sys.stderr.write("[srv][err] " + (fmt % args) + "\n")


def main():
    global ROOT_DIR, CFG, CFG_PATH, PROXY_TABLE, PROXY_PREFIXES
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    if len(sys.argv) > 2:
        ROOT_DIR = os.path.abspath(sys.argv[2])
        # 配置跟随服务根目录（所服务站点自带的 config.json），而非脚本所在目录
        CFG, CFG_PATH = load_config(ROOT_DIR)
        PROXY_TABLE = build_proxy_table(CFG)
        PROXY_PREFIXES = sorted(PROXY_TABLE.keys(), key=len, reverse=True)
    if not os.path.isfile(os.path.join(ROOT_DIR, "index.html")):
        print(f"启动失败：服务根目录里找不到 index.html：{ROOT_DIR}", file=sys.stderr)
        print("请确认在工程目录下执行，如：python3 tools/server.py 8099", file=sys.stderr)
        sys.exit(1)
    try:
        srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    except OSError as e:
        print(f"启动失败：端口 {port} 被占用（{e}）。请先结束旧进程，例如：kill $(lsof -t -i:{port})", file=sys.stderr)
        sys.exit(1)
    routes = " ".join(f"/{pre}->{upstream}" for pre, upstream in PROXY_TABLE.items()) or "(无代理)"
    print(f"serving {ROOT_DIR} · config {CFG_PATH or '未找到，使用空配置'} · proxy {routes} on http://localhost:{port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()