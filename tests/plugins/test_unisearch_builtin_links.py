from .test_unisearch import load_package

load_package()
from unisearch_test_plugin.fetch.builtin.links import extract_links


# 相对链接解析、协议过滤与去重保持文档顺序。
def test_extract_links_resolves_filters_and_deduplicates() -> None:
    html = """
    <a href="/docs/start#intro">Start</a>
    <a href="https://example.com/docs/start#other">Duplicate</a>
    <a href="next?page=1&utm_source=test">Next</a>
    <a href="mailto:test@example.com">Mail</a>
    <a href="javascript:void(0)">Script</a>
    """

    assert extract_links(html, "https://example.com/docs/index") == (
        "https://example.com/docs/start",
        "https://example.com/docs/next?page=1&utm_source=test",
    )
