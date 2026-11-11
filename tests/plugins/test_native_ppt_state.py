"""Native check receipts survive serialization changes, but not actual edits."""

import importlib.util
import sys
import types
from pathlib import Path

plugin = Path(__file__).resolve().parents[2] / "plugins/uniwork-kits"
namespace = types.ModuleType("hermes_native_test")
namespace.__path__ = [str(plugin)]
sys.modules[namespace.__name__] = namespace

import json
import zipfile
from pathlib import Path

import pytest


@pytest.mark.parametrize("dirty", [False, True])
def test_release_uses_actual_editor_pool_and_preserves_unsaved_instances(tmp_path, dirty):
    from hermes_native_test.native_ppt_runtime import NativeRuntime
    engine = NativeRuntime.__new__(NativeRuntime)
    engine.client = object()
    engine.opened = {}
    path = tmp_path / 'work.pptx'
    closed = []
    entries = [{'file_id': key, 'file_path': str(path if key != 'other' else tmp_path/'other.pptx')}
               for key in ('a', 'b', 'other')]

    def rpc(name, args):
        if name == 'get_pool_status':
            return {'open_editors': entries}
        if name == 'slide_get_info':
            return {'is_dirty': dirty and args['file_id'] == 'b'}
        assert name == 'close_file'
        closed.append(args['file_id'])
        return {'ok': True}

    engine.rpc = rpc
    if dirty:
        with pytest.raises(ValueError, match='未保存'):
            engine.release(path)
        assert closed == []
    else:
        engine.release(path)
        assert closed == ['a', 'b']

from hermes_native_test.tencent_ppt_state import A, P, NativePptState, digest, slide_digest


def _slide(text, offset=0, x=60, target=2):
    return f'''<p:sld xmlns:p="{P[1:-1]}" xmlns:a="{A[1:-1]}">
      <p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:cNvPr id="{offset + 1}" name="first"/></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="{x}" y="60"/></a:xfrm></p:spPr>
          <p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>
        <p:sp><p:nvSpPr><p:cNvPr id="{offset + 2}" name="second"/></p:nvSpPr></p:sp>
        <p:cxnSp><p:nvCxnSpPr><p:cNvPr id="{offset + 3}" name="line"/>
          <p:cNvCxnSpPr><a:stCxn id="{offset + 1}" idx="0"/><a:endCxn id="{offset + target}" idx="1"/></p:cNvCxnSpPr>
        </p:nvCxnSpPr></p:cxnSp>
      </p:spTree></p:cSld>
      <p:timing><p:spTgt spid="{offset + 2}"/></p:timing>
    </p:sld>'''.encode()


def _write_ppt(path, count, offset=0, changed_page=None, **change):
    rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    office_rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("ppt/presentation.xml", f'<p:presentation xmlns:p="{P[1:-1]}" xmlns:r="{office_rel_ns}"><p:sldIdLst>'
                         + "".join(f'<p:sldId id="{i + 256}" r:id="rId{i}"/>' for i in range(count)) + '</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>')
        archive.writestr("ppt/_rels/presentation.xml.rels", f'<Relationships xmlns="{rel_ns}">'
                         + "".join(f'<Relationship Id="rId{i}" Target="slides/slide{i + 1}.xml"/>' for i in range(count)) + '</Relationships>')
        for i in range(count):
            options = {"text": f"Page {i + 1}", "offset": offset + i * 10}
            if i == changed_page:
                options.update(change)
            archive.writestr(f"ppt/slides/slide{i + 1}.xml", _slide(**options))


def _checked_deck(tmp_path, count=3):
    path = tmp_path / "deck.pptx"
    _write_ppt(path, count)
    state = NativePptState(path)
    sources = []
    for i in range(count):
        dsl = tmp_path / f"{i + 1:02}.slide"
        dsl.write_text(f"source {i}")
        sources.append(dsl)
        state.wrote(dsl, i)
        state.checked(dsl, i, True)
    return state, sources


def test_append_tenth_page_preserves_previous_checks_and_can_finalize(tmp_path):
    state, sources = _checked_deck(tmp_path, 9)
    _write_ppt(state.path, 10, offset=100)
    state = NativePptState(state.path)
    assert state.summary()["checked_indices"] == list(range(9))
    tenth = tmp_path / "10.slide"
    tenth.write_text("source 9")
    state.wrote(tenth, None)
    state.checked(tenth, 9, True)
    assert NativePptState(state.path).summary()["checked_pages"] == 10
    final = state.finalize(tmp_path)
    state.published()
    assert state.summary()["status"] == "final"
    assert Path(final["file_path"]).read_bytes() == state.path.read_bytes()


@pytest.mark.parametrize("change", [{"text": "Changed"}, {"x": 80}, {"target": 1}])
def test_actual_page_edit_invalidates_only_that_page_and_cannot_be_rechecked_silently(tmp_path, change):
    state, sources = _checked_deck(tmp_path)
    _write_ppt(state.path, 3, offset=100, changed_page=1, **change)
    assert state.summary()["checked_indices"] == [0, 2]
    with pytest.raises(ValueError, match="仅重新upsert-dsl写入第2页"):
        state.checked(sources[1], 1, True)
    with pytest.raises(ValueError, match="第2页"):
        state.finalize(tmp_path)
    state.wrote(sources[1], 1)
    state.checked(sources[1], 1, True)
    assert state.summary()["checked_indices"] == [0, 1, 2]


def test_unsaved_sdk_edits_cannot_deliver_the_previously_checked_disk_version(tmp_path):
    state, _ = _checked_deck(tmp_path, 1)
    state.edited(saved=False)
    with pytest.raises(ValueError, match="未保存修改"):
        NativePptState(state.path).finalize(tmp_path)
    assert not (tmp_path / "deliveries").exists()
    state.edited(saved=True)
    assert state.finalize(tmp_path)["status"] == "final"


def test_changed_source_requires_rewrite_and_failed_lint_stays_failed(tmp_path):
    state, sources = _checked_deck(tmp_path)
    sources[1].write_text("new source")
    with pytest.raises(ValueError, match="重复lint不能修复"):
        state.checked(sources[1], 1, True)
    assert state.summary()["checked_indices"] == [0, 2]
    state.wrote(sources[1], 1)
    state.checked(sources[1], 1, False)
    assert state.summary()["checked_indices"] == [0, 2]
    state.checked(sources[1], 1, True)
    assert state.summary()["checked_pages"] == 3


def test_legacy_receipts_upgrade_without_touching_ppt_or_rechecking(tmp_path):
    state, _ = _checked_deck(tmp_path)
    with zipfile.ZipFile(state.path) as archive:
        raw = [digest(archive.read(f"ppt/slides/slide{i + 1}.xml")) for i in range(3)]
    for i, page in state.data["pages"].items():
        page["xml"] = raw[int(i)]
        page.pop("xml_version")
    state.data["edit_saved"] = raw
    state.receipt.write_text(json.dumps(state.data))
    original = state.path.read_bytes()
    upgraded = NativePptState(state.path)
    receipt = upgraded.receipt.read_bytes()
    assert upgraded.summary()["checked_pages"] == 3
    assert upgraded.summary()["edit_saved"] is True
    assert state.path.read_bytes() == original
    NativePptState(state.path)
    assert state.receipt.read_bytes() == receipt
    _write_ppt(state.path, 3, offset=100)
    assert NativePptState(state.path).summary()["checked_pages"] == 3


def test_stale_legacy_receipt_reports_rewrite_instead_of_check_loop(tmp_path):
    state, sources = _checked_deck(tmp_path)
    state.data["pages"]["1"].update(xml="unrecoverable-old-raw-hash")
    state.data["pages"]["1"].pop("xml_version")
    state.receipt.write_text(json.dumps(state.data))
    state = NativePptState(state.path)
    with pytest.raises(ValueError, match="仅重新upsert-dsl写入第2页"):
        state.checked(sources[1], 1, True)
    assert state.summary()["checked_indices"] == [0, 2]
    state.wrote(sources[1], 1)
    state.checked(sources[1], 1, True)
    assert state.summary()["checked_pages"] == 3


def test_renumbering_keeps_connector_and_animation_identity():
    assert slide_digest(_slide("A")) == slide_digest(_slide("A", offset=100))
    assert slide_digest(_slide("A")) != slide_digest(_slide("A", offset=100, target=1))
    redirected_animation = _slide("A").replace(b'spid="2"', b'spid="1"')
    assert slide_digest(_slide("A")) != slide_digest(redirected_animation)


def test_sdk_generated_chart_name_renumbering_is_not_a_page_edit():
    before = _slide("A").replace(b'</p:spTree>', b'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="52" name="52"/></p:nvGraphicFramePr></p:graphicFrame></p:spTree>')
    after = before.replace(b'id="52" name="52"', b'id="66" name="66"')
    assert slide_digest(before) == slide_digest(after)
    assert slide_digest(before) != slide_digest(after.replace(b'name="66"', b'name="Custom chart"'))
    custom_numeric = before.replace(b'name="52"', b'name="2026"')
    assert slide_digest(custom_numeric) != slide_digest(custom_numeric.replace(b'name="2026"', b'name="2027"'))


def test_version_two_receipt_migrates_before_native_renumbering(tmp_path):
    from hermes_native_test.tencent_ppt_state import _slide_digests

    state, _ = _checked_deck(tmp_path)
    with zipfile.ZipFile(state.path) as archive:
        for i, page in state.data["pages"].items():
            page.update(xml=_slide_digests(archive.read(f"ppt/slides/slide{int(i) + 1}.xml"))[0], xml_version=2)
    state.receipt.write_text(json.dumps(state.data))
    upgraded = NativePptState(state.path)
    assert upgraded.summary()["checked_pages"] == 3


@pytest.mark.parametrize("winerror", [5, 32])
def test_receipt_replace_tolerates_brief_windows_file_occupation(tmp_path, monkeypatch, winerror):
    state, _ = _checked_deck(tmp_path)
    replace = Path.replace
    attempts = []
    delays = []

    def busy_once(path, target):
        attempts.append(target)
        if len(attempts) == 1:
            error = PermissionError("brief file occupation")
            error.winerror = winerror
            raise error
        return replace(path, target)

    monkeypatch.setattr(Path, "replace", busy_once)
    monkeypatch.setattr("hermes_native_test.tencent_ppt_state.time.sleep", delays.append)
    state._save()
    assert len(attempts) == 2 and delays == [0.025]
    assert NativePptState(state.path).summary()["checked_pages"] == 3


@pytest.mark.parametrize("alias", ["deck.pptx", "outputs/deck.pptx", "project/../deck.pptx"])
def test_working_aliases_resolve_existing_file_and_reject_escape(tmp_path, alias):
    from hermes_native_test.native_ppt import NativePresentation
    output = tmp_path / "outputs"
    output.mkdir()
    file = output / "deck.pptx"
    _write_ppt(file, 0)
    work = NativePresentation(output, None)
    assert work._working_path(alias) == file
    with pytest.raises(ValueError, match="outputs"):
        work._working_path("../outside.pptx")
    with pytest.raises(ValueError, match="后缀"):
        work._path("source.py", field="dsl_file", suffix=".slide")


def test_ambiguous_outputs_alias_requires_explicit_path(tmp_path):
    from hermes_native_test.native_ppt import NativePresentation
    output = tmp_path / "outputs"
    (output / "outputs").mkdir(parents=True)
    for path in [output / "deck.pptx", output / "outputs/deck.pptx"]:
        _write_ppt(path, 0)
    work = NativePresentation(output, None)
    with pytest.raises(ValueError, match="歧义"):
        work._working_path("outputs/deck.pptx")
    assert work._working_path(str(output / "deck.pptx")) == output / "deck.pptx"


def test_publication_failure_does_not_mark_saved_snapshot_published(tmp_path):
    from hermes_native_test.native_ppt import NativePresentation
    state, _ = _checked_deck(tmp_path)
    def fail(_):
        raise RuntimeError("presentation unavailable")
    work = NativePresentation(tmp_path, None, publish=fail)
    with pytest.raises(RuntimeError, match="unavailable"):
        work.execute({"action": "finalize", "file_path": str(state.path)})
    assert NativePptState(state.path).summary()["status"] == "draft"
    work.publish = lambda r: "MEDIA:" + r["file_path"]
    assert work.execute({"action": "finalize", "file_path": str(state.path)})["presentation"]["status"] == "final"
    assert NativePptState(state.path).summary()["status"] == "final"


def test_related_image_change_invalidates_only_its_page(tmp_path):
    state, sources = _checked_deck(tmp_path)
    def image(value):
        with zipfile.ZipFile(state.path) as archive:
            parts = {name: archive.read(name) for name in archive.namelist()}
        parts["ppt/slides/_rels/slide2.xml.rels"] = b'<Relationships><Relationship Id="image" Target="../media/image1.png"/></Relationships>'
        parts["ppt/media/image1.png"] = value
        with zipfile.ZipFile(state.path, "w") as archive:
            for name, payload in parts.items():
                archive.writestr(name, payload)
    image(b"first image")
    state.wrote(sources[1], 1)
    state.checked(sources[1], 1, True)
    image(b"different image")
    assert NativePptState(state.path).summary()["checked_indices"] == [0, 2]


def test_relationship_order_does_not_change_page_or_material_checks(tmp_path):
    from hermes_native_test.ppt_material import page_fingerprints
    state, sources = _checked_deck(tmp_path)
    def relationships(reverse=False):
        with zipfile.ZipFile(state.path) as archive:
            parts = {name: archive.read(name) for name in archive.namelist()}
        nodes = [b'<Relationship Id="image" Type="image" Target="../media/image1.png"/>',
                 b'<Relationship Id="link" Type="hyperlink" Target="https://example.org" TargetMode="External"/>']
        parts["ppt/slides/_rels/slide2.xml.rels"] = b'<Relationships>'+b''.join(reversed(nodes) if reverse else nodes)+b'</Relationships>'
        parts["ppt/media/image1.png"] = b"unchanged image"
        with zipfile.ZipFile(state.path, "w") as archive:
            for name, payload in parts.items():
                archive.writestr(name, payload)
    relationships()
    state.wrote(sources[1], 1)
    state.checked(sources[1], 1, True)
    before = page_fingerprints(state.path)
    relationships(reverse=True)
    assert NativePptState(state.path).summary()["checked_indices"] == [0, 1, 2]
    assert before == page_fingerprints(state.path)


def test_internal_draft_is_never_finalized(tmp_path):
    state, _ = _checked_deck(tmp_path)
    state.created(purpose="internal")
    with pytest.raises(ValueError, match="内部"):
        state.finalize(tmp_path)
    assert not (tmp_path / "deliveries").exists()


def test_material_review_retains_issues_without_marking_them_approved(tmp_path):
    from hermes_native_test.native_ppt import NativePresentation
    state, _ = _checked_deck(tmp_path)
    state.data["material_build"] = {"revision": "current", "file_digest": digest(state.path.read_bytes()),
                                     "pending_review": [0, 1, 2]}
    state._save()
    work = NativePresentation(tmp_path, None)
    result = work.execute({"action": "review-material", "file_path": str(state.path), "review_version": "current",
                           "review_issues": {0: "标题遮挡"}, "unconfirmed_pages": {1: "原文不清晰"}})
    assert result["presentation"]["visual_pending_pages"] == [0, 1, 2]
    assert result["presentation"]["visual_issues"] == {"0": "标题遮挡"}
    assert result["presentation"]["visual_unconfirmed_pages"] == {"1": "原文不清晰"}
    with pytest.raises(ValueError, match="一种"):
        work.execute({"action": "review-material", "file_path": str(state.path), "review_version": "current",
                      "reviewed_pages": [0], "review_issues": {0: "标题遮挡"}})
    with pytest.raises(ValueError, match="版本"):
        work.execute({"action": "review-material", "file_path": str(state.path), "review_version": "old",
                      "review_issues": {0: "过时结论"}})


def test_last_material_approval_publishes_once_without_a_separate_model_call(tmp_path):
    from PIL import Image
    from hermes_native_test.native_ppt import NativePresentation
    from hermes_native_test.ppt_layout_guard import CHECK_VERSION
    state, _ = _checked_deck(tmp_path, 1)
    preview = tmp_path / 'saved.png'
    Image.new('RGB', (80, 60), 'white').save(preview)
    state.data['layout_checks'] = {h: CHECK_VERSION for h in state.pages()}
    state.data['material_build'] = {
        'revision': 'current', 'file_digest': digest(state.path.read_bytes()), 'pending_review': [0],
        'require_visual_review': True, 'previews': {'0': str(preview)},
    }
    state._save()
    deliveries = []
    work = NativePresentation(tmp_path, None, publish=lambda receipt: deliveries.append(receipt['file_path']))
    result = work.execute({'action': 'review-material', 'file_path': str(state.path),
                           'review_version': 'current', 'reviewed_pages': [0]})
    assert result['auto_finalized'] and Path(deliveries[0]).is_file()
    assert NativePptState(state.path).summary()['status'] == 'final'
    repeated = work.execute({'action': 'finalize', 'file_path': str(state.path)})
    assert repeated['already_published'] and len(deliveries) == 1


def test_batch_retry_reuses_checked_pages_without_skipping_failed_page(tmp_path):
    from hermes_native_test.native_ppt import NativePresentation

    path = tmp_path / "batch.pptx"
    _write_ppt(path, 0)
    sources = [tmp_path / f"{i}.slide" for i in range(3)]
    for i, source in enumerate(sources):
        source.write_text("broken" if i == 1 else f"source {i}")

    class Engine:
        writes = []
        count = 0

        def open(self, path):
            return "test"

        def cli(self, args, cwd):
            source = Path(args[args.index("--dsl-file") + 1])
            if args[0] == "upsert-dsl":
                index = int(args[args.index("--page-index") + 1]) if "--page-index" in args else self.count
                self.count = max(self.count, index + 1)
                self.writes.append((source, index))
                _write_ppt(path, self.count)
                return {"ok": True}
            return {"ok": source.read_text() != "broken"}

    engine = Engine()
    work = NativePresentation(tmp_path, engine)
    args = {"action": "write-pages", "file_path": str(path), "dsl_files": [str(s) for s in sources]}
    failed = work.execute(args)
    assert not failed["ok"] and len(engine.writes) == 2
    assert NativePptState(path).summary()["checked_indices"] == [0]
    sources[1].write_text("fixed source")
    done = work.execute(args)
    assert done["ok"] and [index for _, index in engine.writes] == [0, 1, 1, 2]
    assert NativePptState(path).summary()["checked_indices"] == [0, 1, 2]
    work.execute(args)
    assert len(engine.writes) == 4


def test_new_material_build_cannot_publish_before_visual_confirmation(tmp_path):
    state, _ = _checked_deck(tmp_path, 1)
    state.data["material_build"] = {"require_visual_review": True, "revision": "r1",
                                    "file_digest": digest(state.path.read_bytes()), "pending_review": [0]}
    state._save()
    with pytest.raises(ValueError, match="未确认"):
        state.finalize(tmp_path)
    assert not (tmp_path / "deliveries").exists()
    state.data["material_build"].update(pending_review=[], review_issues={"0": "漏字"})
    with pytest.raises(ValueError, match="缺陷"):
        state.finalize(tmp_path)
    state.data["material_build"].update(review_issues={}, reviewed_images={"0": "confirmed"})
    assert Path(state.finalize(tmp_path)["file_path"]).is_file()


def test_write_page_rejects_out_of_range_replacement_before_engine_call(tmp_path):
    from hermes_native_test.native_ppt import NativePresentation

    state, sources = _checked_deck(tmp_path, 1)
    before = state.path.read_bytes()
    work = NativePresentation(tmp_path, object())
    with pytest.raises(ValueError, match="page_index"):
        work.execute({"action": "write-page", "file_path": str(state.path),
                      "dsl_file": str(sources[0]), "page_index": 1})
    assert state.path.read_bytes() == before


def test_batch_resource_failure_stops_and_retries_same_page(tmp_path):
    from hermes_native_test.native_ppt import NativePresentation

    path = tmp_path / "resources.pptx"
    _write_ppt(path, 0)
    sources = [tmp_path / f"{i}.slide" for i in range(2)]
    for source in sources:
        source.write_text("page with image")

    class Engine:
        fail = True
        writes = []
        count = 0

        def open(self, path):
            return "test"

        def cli(self, args, cwd):
            if args[0] == "upsert-dsl":
                index = int(args[args.index("--page-index") + 1]) if "--page-index" in args else self.count
                self.count = max(self.count, index + 1)
                self.writes.append(index)
                _write_ppt(path, self.count)
                return {"ok": True, "failures": [{"href": "missing.png"}] if self.fail else []}
            return {"ok": True}

    engine = Engine()
    work = NativePresentation(tmp_path, engine)
    args = {"action": "write-pages", "file_path": str(path), "dsl_files": list(map(str, sources))}
    failed = work.execute(args)
    assert not failed["ok"] and failed["failed_phase"] == "resources" and engine.writes == [0]
    assert not NativePptState(path).summary()["checked_indices"]
    engine.fail = False
    assert work.execute(args)["ok"]
    assert engine.writes == [0, 0, 1]
    assert NativePptState(path).summary()["checked_indices"] == [0, 1]


def test_material_approval_requires_successful_read_of_current_comparison(tmp_path):
    from PIL import Image
    from hermes_native_test import host_hooks, turns
    from hermes_native_test.native_ppt_events import context
    from hermes_native_test.ppt_layout_guard import CHECK_VERSION
    from hermes_native_test.ppt_material import confirm_review

    state, _ = _checked_deck(tmp_path, 1)
    preview, comparison = tmp_path / "saved.png", tmp_path / "comparison.png"
    Image.new("RGB", (80, 60), "white").save(preview)
    Image.new("RGB", (80, 120), "blue").save(comparison)
    state.data["layout_checks"] = {h: CHECK_VERSION for h in state.pages()}
    state.data["material_build"] = {
        "revision": "current", "file_digest": digest(state.path.read_bytes()), "pending_review": [0],
        "require_read_evidence": True, "previews": {"0": str(preview)}, "review_images": {"0": str(comparison)},
    }
    turn = turns.current("material-visual-test")
    turn.native_ppt = True
    token = context.set({"session_id": turn.session_id})
    try:
        # Reading the source, a failed comparison read, or another session cannot approve this page.
        for session, path, result in [
            (turn.session_id, preview, '{"result":"source text"}'),
            (turn.session_id, comparison, '{"error":"upload failed"}'),
            ("different-review-session", comparison, '{"result":"comparison"}'),
        ]:
            turns.current(session).native_ppt = True
            host_hooks.on_transform_tool_result(
                tool_name="mcp__UniAI_Toolkit__analyze_image", args={"image_url_or_oss_path": str(path)},
                result=result, session_id=session,
            )
            with pytest.raises(ValueError, match="尚未实际读取"):
                confirm_review(state, "current", [0])
            assert state.data["material_build"]["pending_review"] == [0]
        host_hooks.on_transform_tool_result(
            tool_name="mcp__UniAI_Toolkit__analyze_image", args={"image_url_or_oss_path": str(comparison)},
            result='{"result":"compared source and saved page"}', session_id=turn.session_id,
        )
        # A regenerated comparison must be read again; a hash receipt cannot approve different bytes.
        Image.new("RGB", (80, 120), "green").save(comparison)
        with pytest.raises(ValueError, match="尚未实际读取"):
            confirm_review(state, "current", [0])
        copied = tmp_path / "same-comparison-copied.png"
        copied.write_bytes(comparison.read_bytes())
        host_hooks.on_transform_tool_result(
            tool_name="desktop_read_image", args={"path": str(copied)},
            result={"_multimodal": True, "content": [{"type": "text", "text": "image path only"}]},
            session_id=turn.session_id,
        )
        with pytest.raises(ValueError, match="尚未实际读取"):
            confirm_review(state, "current", [0])
        import base64
        result = {"_multimodal": True, "content": [{"type": "image_url", "image_url": {
            "url": "data:image/png;base64," + base64.b64encode(copied.read_bytes()).decode(),
        }}]}
        assert host_hooks.on_transform_tool_result(
            tool_name="desktop_read_image", args={"path": str(copied)},
            result=result, session_id=turn.session_id,
        ) is None
        confirm_review(state, "current", [0])
        assert state.data["material_build"]["pending_review"] == []
    finally:
        context.reset(token)


def test_visual_read_survives_real_dispatch_rewriting_local_path_to_oss(tmp_path, monkeypatch):
    import hermes_cli.plugins as framework
    import model_tools
    from hermes_constants import hermes_home_key
    from tools.registry import registry
    from hermes_native_test import host_hooks, turns

    manager = framework.PluginManager()
    manager._discovered = True
    monkeypatch.setattr(framework, "_plugin_manager", manager)
    name = "mcp__PptReadTest__analyze_image"
    local = tmp_path / "comparison.png"
    local.write_bytes(b"comparison image content")
    turn = turns.current("uploaded-comparison")
    assert not turn.native_ppt  # resumed turn reads before its first PPT call
    seen = []

    def uploaded(*, args, next_call, **kw):
        return next_call({**args, "image_url_or_oss_path": "oss://current-comparison"})

    def remote(args):
        seen.append(args["image_url_or_oss_path"])
        return '{"result":"actual image comparison"}'

    # These are the same hook delivery tables the two plugins register into.
    manager._hooks["pre_tool_call"] = [host_hooks.on_pre_tool_call]
    from hermes_native_test.ppt_visual_evidence import around_call
    manager._middleware["tool_execution"] = [uploaded, around_call]
    manager._hooks["transform_tool_result"] = [host_hooks.on_transform_tool_result]
    registry.register(name, "mcp-ppt-read-test", {"name": name, "parameters": {"type": "object"}}, remote,
                      scope=hermes_home_key())
    from hermes_cli.middleware import run_tool_execution_middleware
    original = {"image_url_or_oss_path": str(local), "prompt": "compare source and saved page"}
    manager._middleware["tool_execution"] = [uploaded]
    run_tool_execution_middleware(
        name, original,
        lambda args: model_tools.handle_function_call(name, args, session_id=turn.session_id,
            tool_call_id="before-fix", skip_tool_execution_middleware=True),
        original_args=original, session_id=turn.session_id, tool_call_id="before-fix",
    )
    assert not turn.native_visual_reads
    seen.clear()
    manager._middleware["tool_execution"] = [uploaded, around_call]
    result = run_tool_execution_middleware(
        name, original,
        lambda args: model_tools.handle_function_call(name, args, session_id=turn.session_id,
            tool_call_id="read-1", skip_tool_execution_middleware=True),
        original_args=original, session_id=turn.session_id, tool_call_id="read-1",
    )
    assert json.loads(result)["result"] == "actual image comparison"
    assert seen == ["oss://current-comparison"]
    assert digest(local.read_bytes()) in turn.native_visual_reads.values()
    turn.native_ppt = True
    # The first read is retained even before PPT activation; subsequent reads
    # use the existing PPT-only result cache.
    run_tool_execution_middleware(
        name, original,
        lambda args: model_tools.handle_function_call(name, args, session_id=turn.session_id,
            tool_call_id="read-active", skip_tool_execution_middleware=True),
        original_args=original, session_id=turn.session_id, tool_call_id="read-active",
    )
    seen.clear()
    run_tool_execution_middleware(
        name, original,
        lambda args: model_tools.handle_function_call(name, args, session_id=turn.session_id,
            tool_call_id="read-repeat", skip_tool_execution_middleware=True),
        original_args=original, session_id=turn.session_id, tool_call_id="read-repeat",
    )
    assert not seen


def test_resumed_preview_returns_the_source_saved_images_required_for_approval(tmp_path):
    from PIL import Image
    from hermes_native_test.native_ppt import NativePresentation
    state, _ = _checked_deck(tmp_path, 1)
    preview, original = tmp_path / 'preview.png', tmp_path / 'original.png'
    Image.new('RGB', (80, 45), 'white').save(preview)
    Image.new('RGB', (80, 45), 'blue').save(original)
    state.data['material_build'] = {
        'revision': 'resumed', 'file_digest': digest(state.path.read_bytes()), 'pending_review': [0],
        'changed_pages': [0], 'previews': {'0': str(preview)}, 'reference_images': [str(original)],
    }
    state._save()
    result = NativePresentation(tmp_path, None).execute({'action': 'preview-material', 'file_path': str(state.path)})
    required = NativePptState(state.path).data['material_build']['review_images']['0']
    assert result['review_previews'] == [required]
    assert result['review_batch']['review_batch'][0]['reference_image'] == str(original)
    with Image.open(required) as image:
        assert image.height > 90  # Contains both source and saved page, not just the saved preview.


def test_lint_receipt_cannot_publish_exported_text_outside_canvas(tmp_path):
    from xml.etree import ElementTree as ET
    state, sources = _checked_deck(tmp_path, 1)
    with zipfile.ZipFile(state.path) as archive:
        parts = {name: archive.read(name) for name in archive.namelist()}
    page = ET.fromstring(parts["ppt/slides/slide1.xml"])
    transform = page.find(f".//{P}sp/{P}spPr/{A}xfrm")
    transform.find(A+"off").set("x", "12192000")
    ET.SubElement(transform, A+"ext", cx="1270000", cy="254000")
    parts["ppt/slides/slide1.xml"] = ET.tostring(page)
    with zipfile.ZipFile(state.path, "w") as archive:
        for name, content in parts.items():
            archive.writestr(name, content)
    state.wrote(sources[0], 0)
    state.checked(sources[0], 0, True)
    assert state.summary()["checked_pages"] == 1
    with pytest.raises(ValueError, match="超出页面"):
        state.finalize(tmp_path)
    assert not (tmp_path/"deliveries").exists()
