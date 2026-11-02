Search protocol, Tencent normalization and card components ported from UniClaw
`uniwork_release` at `d413208e1830fa9bc82f506cad1fc6b90e292522`.
Sources: `libs/hexagent/hexagent/tools/web/providers/search/{bocha,tencent}.py`
and `libs/hexagent_demo/frontend/src/tools/renderers/cards/`.
Original contributor authorship is acknowledged; no source history was rewritten.
This self-contained product plugin is packaged through the desktop asset pipeline,
not installed as a new Hermes core tool.

Fetch engines and tests are adapted from the same UniClaw revision:
`libs/hexagent/hexagent/tools/web/providers/fetch/{builtin_parse.py,base.py,builtin/}`
and `_validation.py`, `_markdown.py`, `unicrawl.py`; corresponding unit tests
remain credited to the original contributors. Adaptation replaces HexAgent imports,
environment-based credentials and browser spawning with Hermes provider / scoped
secret / PM / served-profile subprocess APIs. UniCrawl preserves the wire protocol.
No upstream history or author attribution is replaced by a new commit.
