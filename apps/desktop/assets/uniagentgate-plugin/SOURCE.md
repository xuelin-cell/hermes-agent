# Protocol client provenance

Ported from UniClaw `uniwork_release` at `ce575e5cfb7972925f245ecfec3f5e0feaa02e60`:
`libs/hexagent_demo/backend/hexagent_api/channels/uniagentgate/{auth,protocol,stream}.py`.

Original changes include `ef0feece` (initial connector), `559a6f05` (binding),
`65627938` (request headers), `610c667c` (heartbeat/reconnection), and
`872beb42` (bounded authentication recovery). The later protocol/client changes
were authored by lijiyang. This port retains the source protocol/client structure;
the Hermes adapter, health observer and account integration are new.

`X-Agent-Version` reports Hermes's base release version when it is at least
`1.0.0`. Older migration builds (including `0.0.0`) and unknown or invalid
versions send `1.0.0` to satisfy the gateway's minimum; newer versions are
preserved. The registration body's `version` remains the connector version.

The desktop build combines the official bundled plugins and this plugin in
`dist/python-plugins`. Packaging places that complete tree in `resources/python-plugins`,
outside Electron's `app.asar`, and the desktop sets the existing
`HERMES_BUNDLED_PLUGINS` discovery root before starting the backend. Accounts do not
copy or link plugin code. Config, secrets, caches, connections and the control socket
record remain scoped to each account's Hermes home. Legacy account-local copies or
directory links are moved to `plugin-backups/`, outside discovery, before startup so
they cannot shadow the bundled plugin. Fresh accounts need no migration or backups.
Inbound file staging and outbound native-media/link rules are adapted from the same
source commit's `libs/hexagent_demo/backend/hexagent_api/channels/runtime.py`
(`_stage_uniagentgate_attachment`, `_build_uniagentgate_media`). The Hermes media cache,
`MEDIA:` artifact extraction, scoped MCP registry and PM-managed transcoder replace the
old Claw conversation, VM downloader and pre-upload singleton.

This distribution supports text, inbound attachments, combined final text/media replies
and account-scoped manual reconnect and live binding updates. Multiple independently
bound Agents are outside this distribution's single-personal-binding scope; busy input
continues to use Hermes's configured processing policy.
