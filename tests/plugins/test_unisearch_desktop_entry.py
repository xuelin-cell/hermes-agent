"""Desktop URL preparation → native context expansion → real registered tool dispatch."""

import json
from pathlib import Path
import shutil
import subprocess

import pytest

from .test_unisearch_isolation import active, homes, invoke, network_guard, service  # noqa: F401


@pytest.fixture(scope="module")
def desktop_entry(tmp_path_factory):
    """编译并运行真实桌面入口；仅用替身提供所属连接的后端配置响应。"""
    root = Path(__file__).resolve().parents[2]
    node = shutil.which("node")
    assert node, "Node is required for the desktop-to-Python integration"
    output = tmp_path_factory.mktemp("url-entry") / "entry.mjs"
    entry = """
import { prepareWebPrompt } from './apps/desktop/src/app/contrib/unisearch/prompt.ts';
const [backend, text] = process.argv.slice(2);
globalThis.window = {hermesDesktop:{api:async()=>({active_extract_backend:backend})}};
console.log(JSON.stringify(await prepareWebPrompt({text}, {connectionId:'local',profile:'default'})));
"""
    compiler = """
import {build} from 'esbuild';
await build({stdin:{contents:process.argv[1],resolveDir:process.cwd(),loader:'ts'},bundle:true,
platform:'node',format:'esm',outfile:process.argv[2],tsconfig:'apps/desktop/tsconfig.json',logLevel:'silent'});
"""
    subprocess.run([node, "--input-type=module", "-e", compiler, entry, str(output)], cwd=root, check=True, capture_output=True, text=True)

    def prepare(text, backend="builtin_parse"):
        """经真实生产函数获得提交内容，不在测试里复制URL替换算法。"""
        result = subprocess.run([node, str(output), backend, text], cwd=root, check=True, capture_output=True, text=True)
        return json.loads(result.stdout)["text"]

    return prepare


@pytest.mark.parametrize("status", ["partial", "usable", "unavailable"])
def test_desktop_context_and_tool_share_one_quality_entry(homes, service, desktop_entry, status):
    """对照旧预读和新入口，核对真实分发次数、质量字段和404备用抓取。"""
    from agent.context_references import preprocess_context_references
    from agent.web_search_registry import get_provider

    counts = []
    rescue_counts = []
    for optimized in [False, True]:
        home = homes(extract="builtin_parse")
        calls = []
        service.rescues.clear()
        with active(home):
            provider = get_provider("builtin_parse")

            async def page(url, key):
                """仅替换网页worker传输；注册、策略、缓存、预读和工具整理保持真实。"""
                calls.append(url)
                return {"url": url, "title": "fixture", "content": "" if status == "unavailable" else "Actual page body with a next page.",
                        "error": "HTTP 404" if status == "unavailable" else None,
                        "fetch_status": status, "engine": "http",
                        "reasons": {"partial": ["pagination_remaining"], "usable": [], "unavailable": ["http_error"]}[status]}

            provider._fetch = page
            text = '请解释 @url:`https://example.com/entry`'
            if optimized:
                text = desktop_entry(text)
            expanded = preprocess_context_references(text, cwd=home, context_length=32000)
            if optimized:
                assert not expanded.expanded
                assert calls == []
            elif status == "partial":
                assert "Actual page body" in expanded.message
                assert "pagination_remaining" not in expanded.message
            result = invoke(home, "web_extract", {"urls": ["https://example.com/entry"]})
            row = result["results"][0]
            assert result["provider"] == "builtin_parse"
            assert row["fetch_status"] == status
            if status == "partial":
                assert row["reasons"] == ["pagination_remaining"]
                assert row["browser_followup"]["needed"] is True
            if status == "unavailable":
                assert row["content"] == ""
                assert row["reasons"] == ["http_error"]
        counts.append(len(calls))
        rescue_counts.append(len(service.rescues))
    assert counts == ([1, 1] if status == "usable" else [2, 1])
    assert rescue_counts == ([1, 0] if status == "unavailable" else [0, 0])


def test_other_backend_still_uses_native_preread_and_cache(homes, service, desktop_entry):
    """其他后端保留原生预读、缓存及输出，不被Builtin入口策略改写。"""
    from agent.context_references import preprocess_context_references

    home = homes(extract="tavily")
    text = '说明 @url:`https://example.com/native-entry`'
    assert desktop_entry(text, "tavily") == text
    with active(home):
        expanded = preprocess_context_references(text, cwd=home, context_length=32000)
        assert service.content in expanded.message
        result = invoke(home, "web_extract", {"urls": ["https://example.com/native-entry"]})
        assert result["results"][0]["content"] == service.content
    assert len(service.calls) == 1
    assert service.rescues == []
