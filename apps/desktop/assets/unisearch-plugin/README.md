# UniWork web providers for Hermes Desktop

This product plugin registers `unisearch` for `web_search`, and `builtin_parse`
(BuiltinCrawl) / `unicrawl` (UniCrawl) for `web_extract`. Tool names and schemas
remain native. No Hermes agent/tool/gateway core file is patched or monkey-patched.

The served profile owns configuration and credentials. Only
`agent.secret_scope.get_secret("DESKTOP_MT_MAAS_API_KEY")` supplies MaaS credentials;
no secret is written into plugin settings or sent to the browser worker. Non-secret
cloud fields are whitelisted: unisearch_backend, unisearch_url,
unisearch_display_name, fetch_provider, version. Explicit third-party backend
choices and a disabled UniSearch plugin are preserved. The default fetch backend
is builtin_parse. Cloud fetch_provider can switch only plugin-owned fetch choices.

The bundled desktop plugin uses Hermes' official profile-scoped same-name tool
registration. Only its own search/fetch routes use the adapters; every other
provider delegates unchanged arguments to the original native handler. Native
`web.cache_enabled` / `web.keyless_rescue` values are never changed by bootstrap,
session hooks or tool notices. Owned providers retain their Home/route/credential
TTL cache and never send failures to another vendor. Missing credentials are
checked before cache lookup; URL safety and the current profile's website policy
are checked before fetch cache lookup.

The existing bundled-plugin trust gate is used. A separate user-installed copy
still requires Hermes' explicit tool override grant; the plugin never grants
itself permission. The original tool schema, availability gate, result budget and
unload leases are preserved. Since the current ctx registration API does not
forward every metadata field, the adapter copies metadata only to its own newly
created profile registration while holding the native coordinator/registry locks.
This and native helper imports must be covered when upgrading Hermes.

Legacy `native_keyless_rescue` and plugin cache settings do not establish complete
ownership or whether a native field was originally absent. They are preserved as
historical data, never used to guess that an existing native `false` should become
`true`. No shared cache is deleted or reset. A legacy profile requiring restoration
needs reliable prior values; this upgrade does not silently choose them.

BuiltinCrawl ports UniClaw's static HTTP, extraction and Playwright fallback with
DNS/redirect/subresource checks. Browser work runs in a served-profile child env
with credentials scrubbed; the worker closes its browser before exiting. UniCrawl
uses Yuanjing MaaS and accepts direct content or data.markdown responses. Native
website policy, truncation and transcript persistence remain active.

The desktop first applies local plugin defaults before backend discovery. Failure
of that optional setup retains the existing desktop/provider path and emits only
a sanitized diagnostic. Authenticated cloud refresh and resource preparation run
in the background; ntfy instructions are forwarded immediately. Basic account
or core-runtime failures retain their existing startup handling.

Service URLs reject credential-bearing query names using the native Python
URL policy before atomic writes and before requests. The Electron boundary also
rejects the same names. Ordinary business query parameters remain supported.

Python dependencies are declared in plugin.yaml. The desktop prepares them through
PM only when builtin_parse is selected and the plugin is enabled, using an explicit candidate directory (bundled discovery roots are not PM's
account-local plugin directory), and prepares PM-managed Chromium. An unavailable
preparation leaves a sanitized diagnostic and permits desktop startup; fetch errors
remain visible. No raw pip/uv/playwright install command is used.

Public pre/post hooks emit identity-only plugin events (no query/card/key). Desktop
resolves a known exact session owner, deduplicates notices, reads results through
the existing scoped session API and updates the native desktop stream. Stops,
owner changes and a newer turn invalidate pending reads. Native untrusted wrappers
are decoded as data for structured cards/history. Disconnected or missed notices can
be recovered by reopening the stored conversation; no second transcript store exists.

Chromium selection uses hermes_cli.browser_runtime.chromium_executable only;
there is no platform directory scan or implicit Playwright browser-cache fallback.
A missing runtime fails that render operation and retains the existing static
content fallback where available.

All card render fields and nested arrays are validated. Invalid individual cards
are skipped, and the existing RichBoundary contains unexpected card render errors
so answer text and other tool results remain usable.

The UI uses Hermes semantic tokens. Search activity retains Hermes' generic
action and query text without an extra UniSearch badge; existing fetch provider
labels remain. Search
cards preserve the existing five categories and both gold layouts. Answer-only
mode retains cards while ordinary process activity follows Hermes visibility settings.

See PROVENANCE.md for source attribution.

## BuiltinCrawl content assessment

BuiltinCrawl resolves document references against the first valid HTTP(S) value
of the first `base[href]` element; an invalid first value falls back to the final
page URL, not a later `base`. Body links and discovered links use that same base.
Discovery deduplicates ordinary section anchors, while preserving explicit `#/`
and `#!/` application routes. Navigation restores only the fragment after network
validation. A static homepage is not accepted as the body of a requested hash route.

HTTP and rendered candidates are assessed independently, using the same readable evidence projection for extraction, supplements, links and quality. `fetch_status` is
`usable`, `partial`, or `unavailable`; `engine` identifies `http` or `chromium`
when content was assessed, and `reasons` contains bounded stable reason codes.
These fields survive native result ordering, truncation and trimming. `usable`
means no detected limitation, not proof of a complete page. Short notices and
tables can be usable; login/challenge/error pages are not accepted merely because
they contain text. Titles are signals, not sole rejection rules: the assessment also
uses article structure, main login forms and challenge components. A recognized
error heading corroborated by an actual access-failure statement is rejected even
with long paragraphs or a table. Inline code, code blocks and quoted examples are excluded only from the error
evidence copy; their text remains in the returned article. A technical
article titled Login can be retained. Loading evidence is defined in `fetch/builtin/loading.py` for both HTML and
browser observation: main-content loading text/progress indicators and busy
markers on the main content or its covering ancestors. Ancillary, quoted and
explicitly hidden signals are excluded at both stages. Browser observation also
checks computed CSS visibility; static HTML cannot resolve external stylesheets.
Recognized pending content triggers rendering. Dynamic hints may still trigger rendering of readable HTTP content. No extra model call is used for assessment.

A shared Builtin deadline includes queueing and child startup. Rendering gets a
local deadline with time reserved for returning the candidate and closing the
worker. Ordinary render failure or local timeout returns valid static content as
`partial`; cancellation and security refusal do not. A refused main-frame browser
navigation remains a security failure. A wrong hash-route homepage is never a
fallback candidate. Partial and unavailable results are not cached; usable results
retain their assessment in a versioned Builtin-only cache identity. Native and
UniCrawl cache identities are unchanged.

The bounded reading extension below adds simple loading interactions. Forms,
persistent browser sessions, batch checkpointing and automatic UniCrawl fallback
remain outside this change. Whole-batch cancellation and
forced worker termination can still lose completed results. Builtin host-rule
revalidation on cache hits and binding DNS validation to actual outbound addresses
remain separate work. See `docs/desktop-mt/builtincrawl-phase1.md` in the repository
for validation scope and platform limitations.

## Bounded reading interactions (desktop Builtin only)

Explicit read-more/load-more controls, closed details, feed markers and inline
scroll-loading scripts mark content as potentially partial. A readable static page
with only a next-page link returns its current content and a continuation hint;
it does not launch Chromium merely to follow that link.

Once Chromium is needed, it can click narrowly recognized reading buttons or
native details summaries inside the main article, and scroll the document viewport.
There are at most four clicks and four explicit scroll steps, within a local
12-second ceiling and the existing shared request deadline. Progress includes visible
body text, links and item identifiers; status messages and sidebars do not count as
new body content. Each action waits up to two seconds for progress and loading to
settle (at least 0.5 seconds observation, 0.3 seconds quiet); busy or unchanged
controls are not repeatedly clicked on timeout. Scroll position can advance through
already loaded content without requiring new text at each step. At the bottom or
without movement, the sampler stops after its observation window without reporting
a loading timeout unless loading is still active. Initial busy state is awaited
within the shared interaction budget, saving content that arrives during that wait.
Captured readable Markdown blocks
are combined, preserving duplicate blocks within one sample. Invalid login/error
samples are excluded from both body and link output. Verified interactive additions
are preferred over the old static candidate; thin placeholders alone are not.
Total retained HTML samples share the response byte limit. This bounded heuristic
cannot prove complete coverage or distinguish every identical list entry.

Reading controls inside forms/dialogs/navigation are excluded. The automatic
reading phase blocks non-GET/HEAD requests and new document navigations, declines
downloads and dismisses dialogs. Policy-refused navigation remains a failure,
not a successful static fallback. This is not a proof of complete browser egress
isolation; the previously documented network limitations remain.

Automatic interaction results remain `partial`: stable height or a disappearing
button is not evidence of complete coverage. `browser_followup` is generated from
bounded reason codes and survives worker output, native trimming and history.
It tells the agent to inspect and continue with the current session's available
browser tools when more content is needed, or explain the limitation if none are
available. It does not invoke another tool itself, change the core tool schema,
attach to the user's open browser, or create a persistent interaction session.
Loading text is assessed in its surrounding text container, so an emphasized word
or ordinary section heading does not turn an article into a pending load. Explicit
status/busy markers and standalone loading messages still trigger waiting. Block
siblings separate an independent inline or bare-text loading message from nearby
article paragraphs; adjacent inline words remain one context. Hidden siblings and
descendants do not enter that context. Visible inline code/quotes retain sentence
meaning without becoming loading evidence themselves; line breaks separate words.
Static assessment compares only supported valid inline declarations, ignoring
empty/invalid values and respecting importance. Quoted/function text cannot inject
a declaration through a semicolon. Vendor-prefixed, escaped and variable-dependent
values remain unresolved rather than confirming a previous hidden value;
the browser uses computed styles. Static HTML is not a complete CSS engine.
Visibility, declaration parsing and contiguous text-context results are reused only
within one assessment/observation, never across HTML or DOM updates. Unknown
extensions may conservatively trigger browser assessment even when unsupported.
The Builtin cache identity is `builtin-quality-v12` so earlier misclassified results are
not reused. Other fetch backends and their cache identities remain unchanged.

Nested scrolling widgets, arbitrary controls, external-script-only loading without
recognizable markup, login, form entry and pagination remain for the existing
browser workflow. Real model/Electron handoff and Windows/Linux remain unverified.
See `docs/desktop-mt/builtincrawl-interactive-loading.md` for the actual validation.

Static visibility retains visible/hidden/unknown states through context assembly.
Only confirmed visible text forms the confirmed context; uncertain text or block
boundaries keep assessment pending instead of disproving a loading signal. This
can conservatively render or return partial for otherwise complete pages with
unresolved styles. It does not promise complete CSS evaluation. Per-observation
caches remain local and browser observation still uses computed visibility.


## Shared evidence and progressive fetching

`fetch/builtin/visibility.py` owns the static visibility rules and the browser
computed-style predicate. `evidence.py` produces one immutable readable projection
per candidate, retaining static/computed provenance and unresolved/loading/folded
facts. Hidden or unresolved text and structures cannot re-enter through table/list,
article-link or pagination supplements, quality scoring or discovered links.
`aria-hidden` alone does not mean visually hidden; child visibility can recover from
an ancestor's visibility rule, but cannot escape an ancestor's `display:none`,
zero opacity or hidden content-visibility. Closed details retain their summary.
Unopened `hidden=until-found` content remains a limitation, not accepted body text.

Related unknown body evidence triggers verification; unknown auxiliary decorations
do not downgrade a readable article. Unverified text is excluded. If only unknown
body remains, extraction fails; if confirmed body remains, a render failure can
return it as partial. A stylesheet-dependent gate/body conflict has no trusted
static fallback and must be resolved by rendering. Challenge script metadata alone
cannot reject a readable notice. Computed evidence can supersede uncertain static
candidates even when the confirmed rendered text is shorter.

HTTP is always attempted first. Existing-HTML repairs run without another download.
Readable content without unresolved deficits returns immediately; definite HTTP
404/410 stops. Rendering is lazy. A rendered page is sampled and assessed before any
reading interaction: ready content returns without network-idle waits, clicks or
scrolls; thin/empty content can receive bounded settling, busy content bounded
waiting, recognized controls a reading click, and recognized scroll loading bounded
scrolling. A plain long document is not a scroll-loading signal. The existing
4-click/4-scroll/12-second limits are ceilings, not required work.

Browser fingerprint and readable projection come from one synchronous observation;
computed visibility is retained in `RawPage.evidence`, never inferred again from
raw CSS class names. Serialization happens only on changed fingerprints. Both raw
and projected HTML sizes are checked; retained observations share the byte budget.
Interaction results remain partial. Reasons and browser follow-up survive the
existing worker, tool adapter and history path; partial results are not cached.
Only Builtin uses v12; neither v10 nor v11 success entries can bypass the new assessment.

This is DOM evidence, not complete CSS or pixel/occlusion evaluation. Stylesheet-only
hiding without a recognized conflict, arbitrary clipping, shadow DOM, canvas,
embedded frames and external-script-only loading remain capability limits. No new
MCP, tool schema, runtime dependency, core patch or other provider behavior is added.


Readable scope is evaluated from eligible roots: a hidden main container cannot
mask visible fallback body changes. Unknown visibility on a wrapper does not
mark explicitly restored visible descendant text as unknown. Closed native
`dialog` and hidden inputs follow their HTML hiding semantics; explicit dialog
display overrides still follow the shared inline rules. Auxiliary folded/feed
widgets do not request body interaction. Reading hints and click selection share
form/dialog/navigation/inert exclusions and the actual main-content scope.

Scroll loading recognition includes jQuery `.on`/`.bind`/`.scroll` bindings as well
as the existing signals. A recognized scrolling shell still carries `thin_content`
until it has meaningful body evidence, so a temporarily short empty page is not
mistaken for a finished document. Bounded initial settling precedes deciding
whether scrolling is needed; complete rendered pages retain their immediate exit.
These signals remain heuristics; arbitrary external scripts or presentation-only
scroll handlers cannot be classified perfectly from static markup.


### 主正文覆盖（BuiltinCrawl）

提取与质量判断共用当前可读证据。唯一主要 article 中的段落、列表、代码和表格内容被提取器漏选时，从同份 HTML 补回并置于目录结果之前；不靠重抓弥补解析遗漏，也不恢复隐藏或未知文本。质量层检查最终 Markdown 是否覆盖已知主正文，缺失时为 `partial/main_content_missing`。

GitHub 仓库根页只取得文件树、未确认项目介绍时返回 `partial/repository_overview_unverified`；不推断仓库一定存在 README。没有加载或交互证据时保留目录结果，交给任务按需续读，不盲目启动浏览器；子目录和普通数据表保留原行为。Builtin 缓存命名空间为 `builtin-quality-v13`，不复用旧版本误判的 usable；其他后端不变。桌面共享发送入口按用户决定保持现状，其前置配置查询限制仍存在。
