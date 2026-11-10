# Tasks 3–5 execution ledger
Base: 9c2539b2ed. Scope: approved plan tasks 3–5, no Security Center or Codex runtime migration.
- Slice 1: final immutable hook and write_file live engine connected. Rewrite regression changed XFAIL to PASS; junction targets pinned for policy and execution. 8 passed, 1 POSIX skip.
- Slice 2: observed terminal protected-write test fail before wiring; implementing final cwd/workspace distinction and foreground/background gate.
- Ruling: remote execution OS/shell not guessed from the host. Unsupported mapped remote executions fail closed and remain an explicit capability gap.
- Ruling: retain existing checkout and account configuration; do not commit/push or change startup setup.
Guardrail protection roots reuse the original product_install_dir_access rule, including read/write and Shell path references.

- Slice 2: local Bash foreground/background, actual cwd versus workspace, bounded literal script reads and native approval verified.
- Slice 3: replace/V4A full target aggregation before first edit; ordinary Move then Update remains supported; moved-link dependency refused.
- Slice 4: read/search/web/data adapters, inline sequential/thread gates, Tool Search real-tool unwrap and connector final dispatch wired. Real skill/SessionDB/clarify callback/background process tests added.
- Final review: four P1 findings fixed (MSYS, stable link, moved-link sequence, unproven persistent shell environment), with targeted runtime tests. No second reviewer run.
- Ruling: source aliases FileWrite/FileEdit use the corresponding canonical Hermes Write/Edit entry; old aliases remain callable internally. No duplicate runtime approvals.
- Ruling: preserve batch user-rule semantics separately from per-URL hard-deny inspection.
- Ruling: native absent interfaces remain API-only with explicit table entries; do not add unrelated core tools. Real model/client business acceptance remains task 6.
- Ruling: variable-expanded scripts and ambiguous moved-link sequences fail closed pending richer preparation; this restricts availability and is listed explicitly instead of claiming equivalent ALLOW.
- Verification: pre-final 29-file suite 1343 passed, 0 failed, 2 POSIX skipped; final code rerun recorded in final-tests.log. Additional final-adapters: 20 passed, 0 failed, 1 POSIX skipped.
- Baseline audit: 13 stable existing Windows failures reproduced on independent HEAD; initial high-load echo timeout passed in lower-worker rerun.
- Task 3: implemented and basic verification passed for supported execution paths; generic API documented.
- Task 4: implemented and real filesystem plus installed-profile-copy verification passed; malformed patches stop before mutation.
- Task 5: supported Hermes entry adapters and basic verification implemented; API-only/unproven cases remain explicit matrix entries, not equivalent migration claims.
- Final complete suite: 30 files, 1345 passed, 0 failed, 2 POSIX skipped. Addendum installed-copy-tests.log: 7 passed, 0 failed, 2 POSIX skipped. Changed-Python syntax/duplicate-definition audit clean; git diff --check clean.
- Task 6: not started as a total acceptance task. No Git commit/push, active account edits, startup source edits, or production client/model calls.
