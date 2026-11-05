# Desktop code-mode runtime

New desktop chats created in the code workspace send `code_mode: true` on `session.create`.
The backend binds that conversation to the Codex App Server executor while resolving the
selected model and credentials through the existing profile-aware provider chain. Work-mode
chats keep the Hermes executor. Model changes in a code chat keep the Codex executor and
retire its previous child before the next turn. The runtime marker is persisted in the
session model configuration so reopening a code conversation restores its executor.

## Package models

Codex speaks Responses. The session-owned loopback bridge in
`agent/transports/codex_chat_proxy.py` translates requests to the selected model's Chat
Completions service and translates streamed text, reasoning and tool calls back to Responses.
Only the loopback URL and a random per-session bearer token reach Codex; the upstream API
credential stays in the backend. DeepSeek and GLM use reasoning replay for tool turns.
Each profile has its own `codex` directory under `get_hermes_home()` for Codex history.
The current bridge supports Chat Completions routes; selecting an incompatible wire reports
an error instead of silently changing execution engines.

## Bundled CLI

PM owns Codex 0.147.0 in `pm/packages.py` and `pm/lock.json`. Full native desktop payloads
include the verified platform package and its helpers using the existing native tool staging
pipeline. Supported targets are Windows, macOS and Linux on x64/arm64, including Linux musl.
Android/Bionic has no upstream package. A configured `model.codex_bin` remains authoritative;
otherwise the managed CLI is preferred over the user's PATH installation. The light variant
continues to use its separately managed backend runtime rather than embedding a native payload.

## Source attribution

The pure protocol translators `codex_responses_adapter.py` and `codex_provider_adapter.py`
were adapted from HexAgent's `libs/hexagent_demo/backend/hexagent_api/codex/`, source revision
`b0fc59264bc3f2c85e3d7866b4cad1998f2b82a4`, author zhanghr136
(`zhanghr136@noreply.gitcode.com`). The transport and provider-resolution integration reuse
Hermes's existing App Server runtime.
