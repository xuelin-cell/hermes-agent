"""Conservative, explainable candidate assessment; never promises completeness."""

from dataclasses import dataclass
import re

from bs4 import BeautifulSoup

from ..base import FetchResult
from .urls import route_fragment
from .interaction import interaction_hints
from .loading import LOADING_TEXT
from .evidence import html_evidence
from .article import primary_article, article_missing, repository_overview_unverified

_NOTICE = re.compile(
    r"^(?:verify (?:that )?you are human|checking your browser|just a moment|"
    r"attention required|access denied|403(?: forbidden)?|404(?: not found)?|"
    r"page not found|internal server error|service unavailable|502 bad gateway|503 service unavailable|sign in|log in|login|登录|请登录|访问被拒绝|"
    r"请完成(?:安全)?验证|人机验证|页面不存在)[\s.!:：…]*(?:[|—-].*)?$",
    re.I,
)
# HTTP 200也可能承载错误页；错误标题须与实际访问失败说明共同判断。
_ERROR_TITLE = re.compile(
    r"^(?:access denied|403(?: forbidden)?|404(?: not found)?|page not found|"
    r"internal server error|service unavailable|502 bad gateway|503 service unavailable|"
    r"访问被拒绝|页面不存在)[\s.!:：…]*(?:[|—-].*)?$",
    re.I,
)
_ERROR_BODY = re.compile(
    r"^(?:(?:the requested|this) (?:page|resource|url|content) "
    r"(?:is not available|is unavailable|was not found|could not be found|cannot be found|does not exist|has been (?:removed|deleted))|"
    r"(?:you (?:do not|don't) have|you have no) permission|"
    r"you (?:are not authorized|are forbidden)|access (?:to .+? )?(?:is |has been )?denied|"
    r"(?:您|你)(?:没有|无权|无)(?:权限|权访问)|(?:请求的|该|此)(?:页面|资源)(?:不存在|不可用|已删除))",
    re.I,
)


@dataclass(frozen=True)
class Assessment:
    status: str
    reasons: tuple[str, ...] = ()
    structure: int = 0


@dataclass(frozen=True, kw_only=True)
class BuiltinResult(FetchResult):
    fetch_status: str
    engine: str
    reasons: tuple[str, ...] = ()


# 标题只提供线索；联合主正文、访问表单及挑战组件区分阻挡页与相关文章。
def is_access_page(soup, title: str | None, text: str) -> bool:
    scope = soup.select_one("article, main, [role=main]") or soup

    # 表单、导航及代码引用中的词句不作为主正文或访问提示。
    def body_node(node):
        return node.find_parent(
            [
                "form",
                "nav",
                "aside",
                "footer",
                "pre",
                "code",
            ]
        ) is None and not any(parent.get("role") == "dialog" for parent in node.parents)

    heading = next(
        (n.get_text(" ", strip=True) for n in scope.select("h1") if body_node(n)), ""
    )
    paragraphs = [
        n.get_text(" ", strip=True) for n in scope.select("p") if body_node(n)
    ]
    substantial = {p for p in paragraphs if len(p) >= 60}
    table_cells = [n for n in scope.select("td, th") if body_node(n)]
    editorial = scope is not soup and (len(substantial) >= 2 or len(table_cells) >= 2)
    first_line = next(
        (line.strip(" #*\t") for line in text.splitlines() if line.strip()), ""
    )
    notice = any(
        _NOTICE.fullmatch(h.strip()) for h in (title or "", heading, first_line)
    )
    challenge_text = any(
        re.match(
            r"^(?:checking your browser\b|verify (?:that )?you are human\b|please (?:wait while we verify|complete (?:the )?security check)|请完成(?:安全)?验证|正在检查您的浏览器)",
            value,
            re.I,
        )
        for value in [first_line, *paragraphs[:1]]
    )
    component = (
        soup.select_one(
            '[id^="cf-chl-"], [name="cf-turnstile-response"], iframe[src*="captcha"]'
        )
        is not None
    )
    # 主登录表单配长说明仍是门槛；独立文章区与附属登录表单分开判断。
    article = scope if scope.name == "article" else scope.select_one("article")
    separate_article = (
        article is not None
        and len(
            {
                n.get_text(" ", strip=True)
                for n in article.select("p")
                if body_node(n) and len(n.get_text(" ", strip=True)) >= 60
            }
        )
        >= 2
    )
    login_gate = (
        notice
        and scope.select_one('form input[type="password"]') is not None
        and not separate_article
    )
    error_gate = False
    if any(
        _ERROR_TITLE.fullmatch(h.strip()) for h in (title or "", heading, first_line)
    ):
        # 只在错误证据副本中去掉引用，保留真实正文输出及文章结构判断。
        evidence = BeautifulSoup(str(scope), "lxml")
        for node in evidence.select("pre, code, blockquote, q"):
            node.decompose()
        error_gate = any(
            _ERROR_BODY.match(node.get_text(" ", strip=True))
            for node in evidence.select("p, td, th")
            if body_node(node)
        )
    return bool(
        error_gate
        or login_gate
        or (notice and not editorial)
        or (component and (challenge_text or not editorial))
        or (challenge_text and not editorial)
    )


# 可用性与是否补抓分别表达；短公告和表格不因字少而无效。
def assess(page, content, *, requested_url: str, engine: str) -> Assessment:
    text = content.markdown.strip()
    if not text or not any(c.isalnum() for c in text):
        return Assessment("unavailable", ("empty_content",))
    if page.status_code >= 400:
        return Assessment("unavailable", ("http_error",))
    requested_route = route_fragment(requested_url)
    if requested_route and (
        engine == "http" or route_fragment(page.url) != requested_route
    ):
        return Assessment("unavailable", ("target_route_unverified",))
    evidence = content.evidence or html_evidence(page.html)
    soup = BeautifulSoup(evidence.html, "lxml")
    if is_access_page(soup, content.title, text):
        return Assessment("unavailable", ("access_page",))
    has_stylesheet = soup.select_one("style, link[rel~=stylesheet]") is not None
    has_gate_component = (
        soup.select_one(
            '[id^="cf-chl-"], iframe[src*="captcha"], form input[type="password"]'
        )
        is not None
    )
    for node in soup.select("script, style, noscript, nav, footer, aside, form"):
        node.decompose()
    paragraphs = [p.get_text(" ", strip=True) for p in soup.select("p")]
    substantial = sum(len(p) >= 60 for p in paragraphs)
    pending = evidence.pending
    if pending and LOADING_TEXT.fullmatch(text.strip(" #*\t")):
        return Assessment("unavailable", ("access_page",))
    root = soup.select_one("article, main, [role=main]")
    meaningful_root = root is not None and len(root.get_text(" ", strip=True)) >= 12
    tables = len(soup.select("td, th")) >= 2
    lists = len(soup.select("li")) >= 2
    structure = int(meaningful_root) + int(tables) + int(lists) + min(substantial, 4)
    article = primary_article(soup)
    reasons = [
        *(["main_content_missing"] if article is not None and article_missing(article, text) else []),
        *(["repository_overview_unverified"] if repository_overview_unverified(soup, page.url) else []),
        *(getattr(page, "interaction_reasons", ())),
        *interaction_hints(evidence.html),
    ]
    css_gate_uncertain = (
        evidence.source == "html_inferred"
        and has_stylesheet
        and (
            bool(_NOTICE.fullmatch((content.title or "").strip())) or has_gate_component
        )
    )
    # 外部样式可能推翻门槛与正文的矛盾，尚无可确认的静态回退正文。
    if css_gate_uncertain:
        return Assessment("unavailable", ("visibility_unresolved",), structure)
    if evidence.unresolved:
        reasons.append("visibility_unresolved")
    if evidence.folded:
        reasons.append("interaction_required")
    if pending:
        reasons.append("dynamic_content_pending")
    # 有交互线索也可能仍是空薄壳；保留同一质量结论，供浏览器决定是否先等首批内容。
    if not structure and content.text_length < 220:
        reasons.append("thin_content")
    return Assessment(
        "partial" if reasons else "usable", tuple(dict.fromkeys(reasons)), structure
    )


# 先比较有效性和正文结构，长度仅作为同等级候选的辅助。
def candidate_rank(assessment: Assessment, content) -> tuple[int, int, int]:
    return (
        int(assessment.status == "usable"),
        assessment.structure,
        content.text_length,
    )
