# Dockerfile · StitchPlay 运行时镜像（静态站点 + 数据源同源代理 /mf）
#
# 部署方式：Bind Mount（只挂载源码，源码不入镜像）。
#   - 本镜像只含 Python 运行时，不含任何业务代码；业务源码在 docker-compose run 时
#     通过 volumes 从宿主目录 bind mount 到容器 /app（见 docker-compose.yml）。
#   - 因此「更新代码」只需把改动落到宿主源码目录 → `docker compose up -d` 逐容器重建
#     即生效，无需重新 build、更无需重新拉取 python 镜像；只有 Python 基础镜像
#     需要升级时才需要重新拉取。
#   - 服务根目录：server.py 依据自身脚本位置自动定位 ROOT_DIR=/app，
#     静态文件、config 都从宿主源码实时读取（含用户本地 config.json）。
#
# 真实上游地址注入（可选，用配置时二选一）：
#   1) 环境变量 STITCH_UPSTREAM_MF=<http://上游>（推荐，见 docker-compose.yml / .env）
#   2) 在宿主编译目录放本地 config.json（bind mount 自动带入容器，且不入 git/镜像）
#
# 说明：未注入上游时容器仍可正常启动、前端可正常切换数据源；
#   仅 /mf 同源代理暂不可用，主队列会提示「在源设置填写 baseUrl」。
#   注意：本镜像不含业务代码，运行时必须带 /app 源码挂载（见 compose），
#   否则容器内没有 index.html、server.py 会拒绝启动。

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# 挂载点 / 工作目录：源码由 compose 的 bind mount 注入，镜像内保持干净
WORKDIR /app

EXPOSE 8099
CMD ["python3", "/app/tools/server.py", "8099"]