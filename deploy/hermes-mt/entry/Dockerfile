# 入口服务镜像。构建上下文为仓库根目录：
#   docker build -f deploy/hermes-mt/entry/Dockerfile -t hermes-mt-entry:dev .
FROM node:22-bookworm-slim AS node-runtime
FROM python:3.13-slim-bookworm
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN --mount=type=cache,id=hermes-apt-bookworm,target=/var/cache/apt,sharing=locked \
    if [ -f /etc/apt/apt.conf.d/docker-clean ]; then mv /etc/apt/apt.conf.d/docker-clean /tmp/hermes-docker-clean; fi; \
    apt-get update && apt-get install -y --no-install-recommends libstdc++6 libatomic1 && rm -rf /var/lib/apt/lists/* && \
    if [ -f /tmp/hermes-docker-clean ]; then mv /tmp/hermes-docker-clean /etc/apt/apt.conf.d/docker-clean; fi
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_INDEX_URL=${PIP_INDEX_URL}
WORKDIR /app
COPY deploy/hermes-mt/entry/requirements.txt ./requirements.txt
RUN --mount=type=cache,id=hermes-python-pip,target=/root/.cache/pip,sharing=locked \
    pip install --cache-dir /root/.cache/pip --retries 5 -r requirements.txt
COPY deploy/hermes-mt/entry/entry ./entry
COPY deploy/hermes-mt/entry/migrations ./migrations
COPY deploy/hermes-mt/seed ./seed
EXPOSE 9400
CMD ["python", "-m", "entry.app"]

COPY plugins/cloud_messaging/__init__.py plugins/cloud_messaging/media.py /app/plugins/cloud_messaging/
