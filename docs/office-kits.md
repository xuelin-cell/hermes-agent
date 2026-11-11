# Native presentation and Office kits

The `uniwork-kits` plugin installs the native PPT kit and the WorkBuddy-adapted
Word, Excel and PDF kits through the existing package installer. Kit enablement,
user configuration and custom same-named packages are preserved. Expert lifecycle
and non-office kit migrations are outside this change.

## Execution and delivery

- PPT uses the supplied slidep/editor SDK through `TencentPpt`. Topic/report decks
  use the sequential `write-page` workflow; editable material reconstruction uses
  extracted source assets and the material worker. Repairs replace the affected
  page. Finalization creates a separate final snapshot. Working drafts, page
  sources, previews and picture assets are not separate deliverables.
- Word supports creation, whole-document formatting, targeted changes and the
  existing OOXML fallback. Excel keeps the SheetAgent path, precise formula edits,
  recalculation and original-file save safeguards. PDF keeps native extraction,
  local OCR for scanned PDF pages and Chinese-path staging.
- A supplied PPT screenshot uses the existing image tools; the PPT workflow does
  not install a new OCR engine. This is separate from the PDF kit's local OCR.
- Only requested final Office/PDF outputs are attached. A final PPT receipt is
  authoritative; draft and older revision paths remain local. The frontend renders
  one latest final card per working presentation, after the response prose.
- Upload work preserves the owning profile context, reuses in-flight uploads and
  returns a bounded pending result instead of losing a slow upload to hook timeout.

## Runtime provisioning

Large vendor binaries and account state are not Git source files.

PPT packaging uses `scripts/bundles/native_ppt.py` to fetch the pinned distribution
and verify its archive hash. The runtime is staged under `tencent-ppt-runtime/` in
the agent payload. The existing `UNIWORK_BUNDLED_PLUGINS` build setting enables
this Windows payload path. Development installations can set
`uniwork_kits.native_ppt.runtime_dir` in their profile configuration.

For Office, provision validated `office_runtime_assets` and a standalone Python
3.12 runtime using:

```powershell
python scripts/install_workbuddy_office.py --source <office-assets> --python-source <python312>
```

The installer validates the component hashes and writes a versioned manifest.
For a fresh desktop build, set `UNIWORK_OFFICE_RUNTIME` to that verified directory;
the packaging step stages it at `workbuddy-office-runtime/5.9.3` and warms its
PM-managed worker dependencies. Development profiles may configure
`uniwork_kits.native_office.runtime_dir`. No raw pip modifications to the Hermes
core environment are required.

Missing or disabled resources do not silently overwrite a custom package or
downgrade an already installed native Office kit. Verify actual runtime status
and outputs on the target installation; source-only unit tests do not establish
that the vendor runtime is present on another machine.

## Verification

The release integration exercises Office workers, PPT material/state/evidence,
asset retrieval, delivery filtering, uploads, existing background delivery and
kit/profile behavior through `scripts/run_tests.sh`. Frontend receipt deduplication,
PPT model choice and shared picture/layout helpers have focused Vitest tests.
No new model-generated presentation benchmark is part of this source publication.
