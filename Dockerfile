# Dockerfile · StitchPlay 静态站点 + 数据源同源代理（/mf）
#
# 工程为纯 Python 标准库实现（http.server + urllib），无第三方依赖，无需 pip install。
# 运行的是 tools/server.py：既托管前端静态文件，又把 /mf/* 反向代理到沐凡上游。
#
# 真实上游地址的注入方式（两者任选，避免把接口地址写进镜像/仓库）：
#   1) 环境变量：STITCH_UPSTREAM_MF=<http://上游>（推荐，见 docker-compose.yml / .env）
#   2) 挂载真实配置：把含真实 proxies[].upstream 的 config.json 挂载到 /app/config.json 覆盖模板
#
# 说明：本镜像只内置 config.example.json（upstream 为占位「接口地址」），
#       未注入上游时不提供可用代理；请务必按上文配置 STITCH_UPSTREAM_MF 后再运行。

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