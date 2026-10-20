# Protocol client provenance

Ported from UniClaw `uniwork_release` at `ce575e5cfb7972925f245ecfec3f5e0feaa02e60`:
`libs/hexagent_demo/backend/hexagent_api/channels/uniagentgate/{auth,protocol,stream}.py`.

Original changes include `ef0feece` (initial connector), `559a6f05` (binding),
`65627938` (request headers), `610c667c` (heartbeat/reconnection), and
`872beb42` (bounded authentication recovery). The later protocol/client changes
were authored by lijiyang. This port retains the source protocol/client structure;
the Hermes adapter, health observer and account integration are new.

This distribution installs the plugin into each account's own Hermes home.
Inbound file staging and outbound native-media/link rules are adapted from the same
source commit's `libs/hexagent_demo/backend/hexagent_api/channels/runtime.py`
(`_stage_uniagentgate_attachment`, `_build_uniagentgate_media`). The Hermes media cache,
`MEDIA:` artifact extraction, scoped MCP registry and PM-managed transcoder replace the
old Claw conversation, VM downloader and pre-upload singleton.

This distribution supports text, inbound attachments, combined final text/media replies
and account-scoped manual reconnect. Multi-agent routing and complete FIFO parity remain
separate migration work.
