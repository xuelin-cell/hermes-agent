# 入口服务镜像。构建上下文是 deploy/hermes-mt（需要同时拿到 entry/ 和 seed/）：
#   docker build -f entry/Dockerfile -t hermes-mt-entry:dev .
FROM python:3.13-slim
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_INDEX_URL=${PIP_INDEX_URL}
WORKDIR /app
COPY entry/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --retries 5 -r requirements.txt
COPY entry/entry ./entry
COPY entry/migrations ./migrations
COPY seed ./seed
EXPOSE 9400
CMD ["python", "-m", "entry.app"]
