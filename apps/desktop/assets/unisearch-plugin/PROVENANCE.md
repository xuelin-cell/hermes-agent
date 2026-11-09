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

The Builtin correctness adaptation adds document-base/fragment handling, local
candidate assessment and deadline/result propagation on top of those ported
engines. It references the documented engine-waterfall and HTML normalization
ideas discussed against Firecrawl revision
`b93fc0d962bdc927f20ad0ab13b33dfa65da94d3`; no Firecrawl source, service client,
Rust native module or Interact implementation is embedded by this change.

The bounded desktop reading extension is a local implementation on the already
ported Playwright engine. It samples content during limited reading interactions
and returns continuation metadata for Hermes's existing browser tools; it does
not import Firecrawl Actions/Interact code, add Playwright MCP, or replace the
Hermes browser subsystem.

The local review corrections refine access-page assessment, retain validated
interactive candidates, observe link/item changes and wait for loading completion.
They add regression coverage through the existing worker/tool/history path and
do not replace original contributor attribution or introduce Firecrawl code.

The follow-up corrections reject corroborated soft-error pages, separate scroll
position from body progress, and await initial loading within the existing budget.
They remain local changes with no new dependency or core/MCP integration.

The evidence and loading-entry corrections distinguish quoted error examples from
page state and propagate main-content busy markers through static assessment,
rendering and cache admission. These are local Builtin-only changes.

Loading scope, exclusion selectors and text patterns now live in one local policy
used by static assessment and browser observation, including covering ancestors.
The policy separates visible reading context from loading evidence and validates
supported inline CSS declarations before applying precedence; browser observation
uses computed visibility. These refinements add no runtime dependency. Regression fixtures exercise the production
worker, cache and tool-result path. No external implementation, MCP service or
Hermes core modification is added.

Unresolved vendor/escaped CSS values no longer confirm an earlier hidden value.
Per-observation visibility and contiguous-context memoization removes repeated
scanning without retaining state across DOM updates. These are local changes.

Unknown visibility now remains separate from confirmed context through static
assessment; it cannot turn a pending load into a successful cached result merely
by concatenating uncertain decorative text. This local policy change preserves
per-observation memoization and the existing browser/worker/tool integration.


The shared readable-evidence projection and progressive render/interaction gates
are local Builtin implementations on those existing engines. Static three-state
inference and computed browser evidence share visibility semantics across body,
quality, loading and controls. This change uses no external crawler source or new
dependency, preserves contributor attribution and changes neither Hermes core nor
other fetch backends. Paired local fixtures distinguish the original base, the
previous uncommitted optimization and this repair; they are not a public-web SLA.


The follow-up local review aligns eligible content roots, uncertainty on direct
text, native hidden elements and reading-control exclusions. Public-page probes
identified missed jQuery scroll loading and a premature empty-shell stop; local
regressions and real-network comparisons verify the fixes. No third-party crawler
implementation, Hermes core change or other backend adaptation is introduced.
