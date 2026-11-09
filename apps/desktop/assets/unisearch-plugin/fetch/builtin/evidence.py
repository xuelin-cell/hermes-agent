"""Shared readable projection and provenance, confined to one Builtin candidate."""

from dataclasses import dataclass
from bs4 import BeautifulSoup, Comment

from .visibility import StaticVisibility
from .loading import has_loading_content

_METADATA = frozenset({"head", "title", "meta", "base", "link", "script", "style"})
_AUXILIARY = frozenset(
    {"nav", "aside", "footer", "script", "style", "template", "head", "noscript"}
)


@dataclass(frozen=True, slots=True)
class PageEvidence:
    html: str
    source: str
    pending: bool = False
    unresolved: bool = False
    folded: bool = False


# 相关未知才影响结果；导航装饰和技术元数据不能拖累正文。
def _relevant(node, roots):
    lineage = [node, *node.parents]
    return not any(
        p.name in _AUXILIARY or p.get("role") == "dialog" for p in lineage
    ) and (not roots or any(any(p is root for p in lineage) for root in roots))


# 先冻结可见性，再投影同一棵树；不能因删父节点丢掉恢复可见的子正文。
def html_evidence(html: str) -> PageEvidence:
    soup = BeautifulSoup(html, "lxml")
    visibility = StaticVisibility()
    pending = has_loading_content(soup, visibility=visibility)
    roots = [
        node
        for node in soup.select("main, article, [role=main]")
        if visibility(node) is not False and _relevant(node, ())
    ]
    states = [(node, visibility(node)) for node in soup.find_all(True)]
    folded = any(
        str(node.get("hidden", "")).lower() == "until-found"
        and visibility(node.parent) is not False
        and _relevant(node, roots)
        for node, _ in states
    )
    unresolved = False
    for node, state in states:
        if state is None and _relevant(node, roots):
            unresolved |= bool(
                any(
                    not isinstance(text, Comment) and str(text).strip()
                    for text in node.find_all(string=True, recursive=False)
                )
                or str(node.get("aria-busy", "")).lower() == "true"
                or node.name in {"input", "iframe"}
            )
    for text in list(soup.find_all(string=True)):
        if isinstance(text, Comment):
            continue
        if text.parent.name not in _METADATA and visibility(text.parent) is not True:
            text.extract()
    for node, state in states:
        if node.name in _METADATA:
            continue
        if state is not True:
            # 隐藏容器不再提供表格、标题、表单或挑战组件结构证据。
            node.name = "span"
            node.attrs = {}
        else:
            node.attrs.pop("style", None)
            node.attrs.pop("hidden", None)
    return PageEvidence(str(soup), "html_inferred", pending, unresolved, folded)
