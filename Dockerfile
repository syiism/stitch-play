# Dockerfile · StitchPlay 静态站点 + 数据源同源代理（/mf）
#
# 工程为纯 Python 标准库实现（http.server + urllib），无第三方依赖，无需 pip install。
# 运行的是 tools/server.py：既托管前端静态文件，又把 /mf/* 反向代理到沐凡上游。
#
# 真实上游地址为「可选」注入（用配置时二选一，避免把接口地址写进镜像/仓库）：
#   1) 环境变量：STITCH_UPSTREAM_MF=<http://上游>（推荐，见 docker-compose.yml / .env）
#   2) 挂载真实配置：把含真实 proxies[].upstream 的 config.json 挂载到 /app/config.json 覆盖模板
#
# 说明：上游为可选。本镜像只内置 config.example.json（upstream 为占位「接口地址」）。
#   未注入上游时：容器仍可正常启动、前端可正常切换数据源（前端已支持无 baseUrl 切源）；
#   只是 /mf 同源代理暂不可用，主队列会因拉取失败而单独提示「在源设置填写 baseUrl」。
#   需要真实数据时再注入 STITCH_UPSTREAM_MF 或挂载 config.json 即可，无需重启镜像重新构建。

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# 拷贝工程（.git / config.json 等已由 .dockerignore 排除，避免真实地址进入构建上下文）
COPY index.html swipe.html styles.css swipe.css README.md AGENTS.md ./
COPY src ./src
COPY tools ./tools
COPY docs ./docs
COPY config.example.json ./config.example.json

EXPOSE 8099
CMD ["python3", "tools/server.py", "8099"]