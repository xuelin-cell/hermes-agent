"""Visible main text must survive extraction even when a file table wins scoring."""

from dataclasses import replace
from unittest.mock import AsyncMock

import pytest

from .test_unisearch import load_package

load_package()
from unisearch_test_plugin.fetch.builtin.content import (
    extract_content,
)
from unisearch_test_plugin.fetch.builtin.evidence import PageEvidence
from unisearch_test_plugin.fetch.builtin.http import RawPage
from unisearch_test_plugin.fetch.builtin.quality import assess
from unisearch_test_plugin.fetch.builtin_parse import BuiltinParseFetchProvider
from unisearch_test_plugin.fetch.status import result_status

URL = "https://github.com/example/project"
BODY = "This repository provides a learning assistant with persistent memory and practical installation instructions."
TABLE = (
    "<table>"
    + "".join(
        f'<tr><td><a href="/example/project/blob/main/file{i}.py">file{i}.py</a></td><td>Updated module number {i}</td></tr>'
        for i in range(20)
    )
    + "</table>"
)
DIRECTORY = "\n".join(f"| file{i}.py | Updated module number {i} |" for i in range(20))


# 模拟文章提取器只选中文件表，验证同份可见证据就地恢复而非再次联网。
@pytest.mark.parametrize("engine", ["http", "chromium"])
@pytest.mark.asyncio
async def test_visible_article_restored_without_browser(monkeypatch, engine):
    monkeypatch.setattr("trafilatura.extract", lambda *a, **kw: DIRECTORY)
    html = f"<main>{TABLE}<article><h1>Overview</h1><p>{BODY}</p><pre>pip install example-project</pre></article></main>"
    evidence = None if engine == "http" else PageEvidence(html, "browser_computed")
    content = extract_content(html, URL, evidence=evidence)
    assert BODY in content.markdown
    assert "pip install example-project" in content.markdown
    assert content.markdown.index(BODY) < content.markdown.index("file0.py")
    assert (
        assess(
            RawPage(html, URL, 200, {}), content, requested_url=URL, engine=engine
        ).status
        == "usable"
    )
    provider = BuiltinParseFetchProvider()
    provider._http.fetch = AsyncMock(return_value=RawPage(html, URL, 200, {}))
    provider._browser.render = AsyncMock(
        side_effect=AssertionError("static article needs no browser")
    )
    result = await provider.fetch(URL)
    assert BODY in result.content
    provider._http.fetch.assert_awaited_once()
    provider._browser.render.assert_not_awaited()


# 结构和长度不能掩盖已知正文缺失；质量层独立核对最终内容。
def test_directory_only_output_is_not_usable_when_article_exists():
    html = f"<main>{TABLE}<article><p>{BODY}</p></article></main>"
    extracted = extract_content(html, URL)
    missing = replace(extracted, markdown=DIRECTORY, text_length=len(DIRECTORY))
    quality = assess(
        RawPage(html, URL, 200, {}), missing, requested_url=URL, engine="http"
    )
    assert quality.status == "partial"
    assert "main_content_missing" in quality.reasons
    wire = result_status({
        "content": DIRECTORY,
        "fetch_status": quality.status,
        "reasons": quality.reasons,
        "engine": "http",
    })
    assert "main_content_missing" in wire["reasons"]
    assert wire["browser_followup"]["needed"]


# 隐藏和未知README不得被恢复成正文，目录本身也不证明获得仓库介绍。
@pytest.mark.parametrize(
    "attribute", ["hidden", 'style="display:none"', 'style="display:var(--unknown)"']
)
def test_hidden_or_unknown_article_never_restored(monkeypatch, attribute):
    monkeypatch.setattr("trafilatura.extract", lambda *a, **kw: DIRECTORY)
    html = f"<main>{TABLE}<article {attribute}><p>{BODY}</p></article></main>"
    content = extract_content(html, URL)
    assert BODY not in content.markdown
    quality = assess(
        RawPage(html, URL, 200, {}), content, requested_url=URL, engine="http"
    )
    assert quality.status == "partial"
    assert "repository_overview_unverified" in quality.reasons


# 仓库根页只有目录时说明范围；不把子目录、普通数据表或目录站点误判成缺README。
@pytest.mark.parametrize(
    "url,expected",
    [
        (URL, "partial"),
        (URL + "/tree/main/src", "usable"),
        ("https://example.com/directory", "usable"),
    ],
)
def test_directory_scope(url, expected):
    html = "<main>" + TABLE + "</main>"
    content = extract_content(html, url)
    quality = assess(
        RawPage(html, url, 200, {}), content, requested_url=url, engine="http"
    )
    assert quality.status == expected


# 合法列表、短正文、带内联格式与链接的文章无需新增补抓。
@pytest.mark.parametrize(
    "article",
    [
        "<article><p>A short but useful README.</p></article>",
        '<article><p>This <strong>project</strong> provides <a href="/guide">practical installation instructions</a> for developers.</p></article>',
        "<article><h1>Data</h1><table><tr><td>CPU</td><td>4 cores</td></tr></table></article>",
    ],
)
def test_complete_articles_remain_usable(article):
    html = "<main>" + article + "</main>"
    content = extract_content(html, URL)
    quality = assess(
        RawPage(html, URL, 200, {}), content, requested_url=URL, engine="http"
    )
    assert quality.status == "usable"


# 侧栏文章不能作为需要补抓的主正文证据。
def test_auxiliary_article_does_not_replace_main(monkeypatch):
    text = "Current catalog information for the requested products is available here."
    monkeypatch.setattr("trafilatura.extract", lambda *a, **kw: text)
    html = f"<main><p>{text}</p></main><aside><article><p>{BODY}</p></article></aside>"
    content = extract_content(html, "https://example.com/catalog")
    assert BODY not in content.markdown
    assert (
        assess(
            RawPage(html, URL, 200, {}), content, requested_url=URL, engine="http"
        ).status
        == "usable"
    )


# 短README也可以提供真实介绍，不按长度判定缺失。
def test_short_readme_with_file_table_is_usable():
    html = "<main>" + TABLE + "<article><p>示例项目。</p></article></main>"
    content = extract_content(html, URL)
    assert "示例项目" in content.markdown
    assert (
        assess(
            RawPage(html, URL, 200, {}), content, requested_url=URL, engine="http"
        ).status
        == "usable"
    )


# 没有加载迹象的目录缺口不盲目启动浏览器；保留partial供实际任务决定续读。
@pytest.mark.asyncio
async def test_directory_without_loading_does_not_render():
    provider = BuiltinParseFetchProvider()
    provider._http.fetch = AsyncMock(
        return_value=RawPage("<main>" + TABLE + "</main>", URL, 200, {})
    )
    provider._browser.render = AsyncMock(
        side_effect=AssertionError("no loading evidence")
    )
    result = await provider.fetch(URL)
    assert result.fetch_status == "partial"
    assert "repository_overview_unverified" in result.reasons
    provider._browser.render.assert_not_awaited()


# 旧版本误判结果不能遮蔽修复，partial结果不进入可用缓存。
@pytest.mark.asyncio
async def test_old_usable_cache_does_not_mask_new_quality(tmp_path):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from unisearch_test_plugin.fetch.providers import BuiltinParseProvider
    from unisearch_test_plugin import cache

    token = set_hermes_home_override(tmp_path)
    try:
        provider = BuiltinParseProvider(lambda key, default=None: default)
        cache.put(
            cache.identity(
                "builtin-quality-v12", cache.identity(provider.name, "", "", URL)
            ),
            {
                "success": True,
                "data": {"content": "OLD_DIRECTORY", "fetch_status": "usable"},
            },
            provider._config,
        )
        provider._fetch = AsyncMock(
            return_value={
                "url": URL,
                "content": DIRECTORY,
                "fetch_status": "partial",
                "engine": "http",
                "reasons": ["repository_overview_unverified"],
            }
        )
        for _ in range(2):
            row = (await provider.extract([URL]))[0]
            assert row["content"] == DIRECTORY and row["fetch_status"] == "partial"
            assert row["browser_followup"]["needed"]
        assert provider._fetch.await_count == 2
    finally:
        reset_hermes_home_override(token)
