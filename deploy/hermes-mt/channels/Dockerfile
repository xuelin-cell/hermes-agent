# Build context: repository root. This service never loads an LLM or user toolset.
FROM python:3.13-slim-bookworm
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PIP_INDEX_URL=${PIP_INDEX_URL} PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/app:/opt/hermes
WORKDIR /app
COPY deploy/hermes-mt/entry/requirements.txt /tmp/entry-requirements.txt
COPY deploy/hermes-mt/channels/requirements.txt /tmp/channels-requirements.txt
RUN --mount=type=cache,id=hermes-python-pip,target=/root/.cache/pip,sharing=locked \
    pip install --cache-dir /root/.cache/pip -r /tmp/entry-requirements.txt -r /tmp/channels-requirements.txt
COPY deploy/hermes-mt/entry/entry /app/entry
COPY deploy/hermes-mt/entry/migrations /app/migrations
COPY deploy/hermes-mt/channels/config.yaml /app/config.yaml
COPY apps/desktop/assets/uniagentgate-plugin /opt/hermes/apps/desktop/assets/uniagentgate-plugin
COPY hermes_cli /opt/hermes/hermes_cli
COPY hermes_platform /opt/hermes/hermes_platform
COPY pm /opt/hermes/pm
COPY hermes_constants.py pyproject.toml /opt/hermes/
CMD ["python", "-m", "entry.channels_service", "/app/config.yaml"]

COPY plugins/cloud_messaging/__init__.py plugins/cloud_messaging/media.py /opt/hermes/plugins/cloud_messaging/
