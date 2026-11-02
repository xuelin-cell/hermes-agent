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
