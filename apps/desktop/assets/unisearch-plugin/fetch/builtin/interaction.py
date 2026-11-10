"""Bounded reading interactions; no form filling or cross-page automation."""

import asyncio
from dataclasses import dataclass
import re

from bs4 import BeautifulSoup
from .loading import BROWSER_LOADING, EXCLUDED_SELECTOR, ROOT_SELECTOR
from .evidence import PageEvidence
from .visibility import StaticVisibility, BROWSER_VISIBILITY

# 只认明确的阅读操作，泛化的“更多/继续”可能是购买或提交按钮。
READ_LABEL = re.compile(
    r"^(?:展开全文|展开全部|展开正文|阅读全文|加载更多|显示更多|"
    r"显示更多评论|加载更多评论|load more|show more|read more|"
    r"expand all|show full (?:article|text)|read full article)$",
    re.I,
)
_NEXT_LABEL = re.compile(r"^(?:下一页|下页|next(?: page)?)$", re.I)
_SCROLL_HINT = re.compile(
    r"(?:infinite[-_ ]?scroll|IntersectionObserver|addEventListener\(\s*['\"]scroll['\"]|\.\s*(?:on|bind)\(\s*['\"]scroll['\"]|\.\s*scroll\s*\()",
    re.I,
)

CONTROL_EXCLUDED = "form,nav,aside,footer,[role=dialog],[inert]"


# 静态HTML只识别线索；隐藏控制、表单和导航不能作为自动点击目标。
def interaction_hints(html: str) -> tuple[str, ...]:
    soup = BeautifulSoup(html, "lxml")
    reasons = []
    visible = StaticVisibility()
    excluded = {id(node) for node in soup.select(CONTROL_EXCLUDED)}
    for node in soup.select("button, a, [role=button], details:not([open])"):
        ancestors = [node, *node.parents]
        if visible(node) is not True:
            continue
        if node.has_attr("disabled") or node.get("aria-disabled") == "true":
            continue
        label = node.get("aria-label") or node.get_text(" ", strip=True)
        if "next" in node.get("rel", []) or _NEXT_LABEL.fullmatch(label):
            reasons.append("pagination_remaining")
        if any(id(n) in excluded for n in ancestors):
            continue
        if not any(
            n.name in {"main", "article"} or n.get("role") == "main" for n in ancestors
        ):
            continue
        if node.get("type", "").lower() in {"submit", "reset"} or any(
            node.has_attr(key) for key in ("form", "formaction", "popovertarget")
        ):
            continue
        if node.name == "details" or READ_LABEL.fullmatch(label):
            reasons.append("interaction_required")
    # rel=next也可能位于head或导航；仅提示，不自动访问。
    if soup.select_one("link[rel~=next]"):
        reasons.append("pagination_remaining")
    # feed与浏览器采样使用相同正文root范围，正文外普通section也不能触发补抓。
    root_excluded = {id(node) for node in soup.select(EXCLUDED_SELECTOR)}
    roots = [
        node
        for node in soup.select(ROOT_SELECTOR)
        if visible(node) is True
        and not any(id(parent) in root_excluded for parent in [node, *node.parents])
    ] or [soup.body or soup]
    root_ids = {id(node) for node in roots}
    if any(
        visible(node) is True
        and any(id(parent) in root_ids for parent in [node, *node.parents])
        and not any(id(n) in excluded for n in [node, *node.parents])
        for node in soup.select("[role=feed], [data-infinite-scroll]")
    ) or any(
        _SCROLL_HINT.search(script.get_text()) for script in soup.select("script")
    ):
        reasons.append("interaction_required")
    return tuple(dict.fromkeys(reasons))


@dataclass(frozen=True)
class Capture:
    snapshots: tuple[str, ...]
    reasons: tuple[str, ...]
    evidence: tuple[PageEvidence, ...] = ()


# 阅读进度包含可见正文、链接和条目标识；状态文案、控件及旁栏不算新正文。
_READING_STATE = r"""previousFingerprint => {
    const excluded = 'script,style,noscript,nav,aside,footer,form,button,summary,[role=dialog],[role=button],[role=status],[role=progressbar]';
    const loading = (__BROWSER_LOADING__)();
    const roots = loading.roots;
    const scopes = roots.filter(e => !roots.some(p => p !== e && p.contains(e))); 
    const visible = loading.visible;
    const text = [], links = [], identities = [];
    const busy = loading.busy;
    for (const scope of scopes) {
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const n = walker.currentNode, e = n.parentElement, value = n.textContent.trim();
            if (!value || !visible(e) || e.closest(excluded)) continue;
            if (loading.textIsLoading(n)) continue;
            text.push(value.replace(/\s+/g, ' '));
        }
        for (const e of scope.querySelectorAll('a[href],[data-id],[data-key],[data-item-id]')) {
            if (!visible(e) || e.closest(excluded)) continue;
            if (e.matches('a[href]')) links.push(e.href);
            for (const key of ['data-id','data-key','data-item-id']) {
                if (e.hasAttribute(key)) identities.push([key,e.getAttribute(key)]);
            }
        }

    }
    const scroller = document.scrollingElement || document.documentElement;
    const scopedNodes = selector => scopes.flatMap(e => [e,...e.querySelectorAll(selector)]).filter(e => e.matches(selector) && !e.closest(excluded));
    const scroll = scopedNodes('[role=feed],[data-infinite-scroll]').some(visible) ||
        [...document.scripts].some(e => /__SCROLL_HINT__/i.test(e.textContent));
    const folded = scopedNodes('[hidden=until-found i]').some(e => e.parentElement && visible(e.parentElement));
    const fingerprint = JSON.stringify([text,links,identities,busy,scroll,folded]);
    let html = null, rawBytes = 0;
    if (fingerprint !== previousFingerprint) {
        // 只改克隆树；每份正文与可见性来自同一次同步取证。
        rawBytes = new TextEncoder().encode(document.documentElement.outerHTML).length;
        const clone = document.documentElement.cloneNode(true);
        const originals = [document.documentElement,...document.documentElement.querySelectorAll('*')];
        const copies = [clone,...clone.querySelectorAll('*')];
        const metadata = new Set(['head','title','meta','base','link','script','style']);
        for (let i=0;i<originals.length;i++) {
            const e=originals[i], c=copies[i];
            if (metadata.has(e.localName)) continue;
            if (!visible(e)) {
                for (const n of [...c.childNodes]) if (n.nodeType === Node.TEXT_NODE) n.remove();
                // 保留可能恢复visibility的子节点，但隐藏容器不再算表格/表单等证据。
                const neutral=document.createElement('span');
                while(c.firstChild) neutral.append(c.firstChild);
                c.replaceWith(neutral);
            } else {
                c.removeAttribute('hidden');
                c.removeAttribute('style');
            }
        }
        html=clone.outerHTML;
    }
    return {fingerprint,busy,scroll,folded,html,rawBytes,
        top:scroller.scrollTop,height:scroller.scrollHeight,view:scroller.clientHeight};

}""".replace("__BROWSER_LOADING__", BROWSER_LOADING).replace(
    "__SCROLL_HINT__", _SCROLL_HINT.pattern
)


# 点击等待正文进度，滚动同时识别位置推进；初始加载在总预算内等待并留存采样。
async def collect_loaded(
    page, initial_html: str, *, budget_seconds: float, max_bytes: int
) -> Capture:
    from playwright.async_api import Error as PlaywrightError

    snapshots = []
    evidences = []
    used = 0
    reasons = []
    clicks = scrolls = 0
    original_url = page.url
    loop = asyncio.get_running_loop()
    saved = None

    # 统一采样与地址/字节边界，等待和操作阶段都不能丢掉已经到达的正文。
    async def observe():
        nonlocal used, saved
        if page.url != original_url:
            reasons.append("interaction_navigation")
            return None
        current = await page.evaluate(_READING_STATE, saved)
        if current["html"] is not None:
            html = current["html"]
            size = max(len(html.encode("utf-8")), current["rawBytes"])
            if used + size > max_bytes:
                reasons.append("interaction_limit")
                return None
            snapshots.append(html)
            evidences.append(
                PageEvidence(
                    html, "browser_computed", current["busy"], folded=current["folded"]
                )
            )
            used += size
        saved = current["fingerprint"]
        return current

    # busy不是超时；不点按钮，等加载结束且短暂稳定，取消和总截止由外层处理。
    async def wait_until_idle(current):
        if not current["busy"]:
            return current
        reasons.append("interaction_scope_limited")
        idle_since = None
        while True:
            previous_fingerprint = current["fingerprint"]
            await asyncio.sleep(0.1)
            current = await observe()
            if current is None:
                return None
            if current["busy"] or current["fingerprint"] != previous_fingerprint:
                idle_since = None
            elif idle_since is None:
                idle_since = loop.time()
            elif loop.time() - idle_since >= 0.3:
                return current

    try:
        async with asyncio.timeout(max(0.01, budget_seconds)):
            for _ in range(8):
                previous = await observe()
                if previous is None:
                    break
                previous = await wait_until_idle(previous)
                if previous is None:
                    break
                candidates = page.locator(
                    "main button, article button, [role=main] button, "
                    "main details:not([open]) > summary, article details:not([open]) > summary, "
                    "[role=main] details:not([open]) > summary"
                )
                target = None
                for i in range(min(await candidates.count(), 60)):
                    node = candidates.nth(i)
                    if not await node.is_visible() or not await node.is_enabled():
                        continue
                    meta = await node.evaluate(
                        (
                            """e => ({
                        visible: (__BROWSER_VISIBILITY__)().visible(e),
                        excluded: !!e.closest('__CONTROL_EXCLUDED__,[aria-busy=true]') ||
                            e.hasAttribute('form') || e.hasAttribute('formaction') ||
                            e.hasAttribute('popovertarget'),
                        type: e.getAttribute('type'), tag: e.tagName,
                        label: (e.getAttribute('aria-label') || e.innerText || '').trim()
                    })"""
                        )
                        .replace("__BROWSER_VISIBILITY__", BROWSER_VISIBILITY)
                        .replace("__CONTROL_EXCLUDED__", CONTROL_EXCLUDED)
                    )
                    if (
                        not meta["visible"]
                        or meta["excluded"]
                        or meta["type"] in {"submit", "reset"}
                    ):
                        continue
                    if meta["tag"] == "SUMMARY" or READ_LABEL.fullmatch(meta["label"]):
                        target = node
                        break
                if target is not None:
                    if clicks >= 4:
                        reasons.append("interaction_limit")
                        break
                    await target.click(timeout=1200, no_wait_after=True)
                    clicks += 1
                else:
                    if not previous["scroll"]:
                        break
                    if previous["top"] + previous["view"] >= previous["height"] - 2:
                        break
                    if scrolls >= 4:
                        reasons.append("interaction_limit")
                        break
                    await page.evaluate(
                        "() => window.scrollBy(0, Math.max(300, innerHeight * .85))"
                    )
                    scrolls += 1
                started = loop.time()
                last_change = started
                progressed = False
                completed = False
                current = previous
                while loop.time() - started < 2.0:
                    old_fingerprint = saved
                    current = await observe()
                    if current is None:
                        return Capture(
                            tuple(snapshots),
                            tuple(dict.fromkeys(reasons)),
                            tuple(evidences),
                        )
                    if current["fingerprint"] != old_fingerprint:
                        last_change = loop.time()
                        progressed = True
                    if current["busy"]:
                        last_change = loop.time()
                    # 没有新正文也可滚过旧区域；到达底部仍留局部时间等可能的懒加载。
                    advancing = target is None and current["top"] > previous["top"] + 1
                    before_bottom = (
                        current["top"] + current["view"] < current["height"] - 2
                    )
                    if (
                        (progressed or advancing and before_bottom)
                        and not current["busy"]
                        and loop.time() - last_change >= 0.3
                        and loop.time() - started >= 0.5
                    ):
                        completed = True
                        break
                    await asyncio.sleep(0.1)
                if not completed:
                    # 点击无进度或仍busy才是等待到期；无位移/到底不能虚报加载超时。
                    if target is not None or current["busy"]:
                        reasons.append("interaction_timeout")
                    break
            if clicks or scrolls:
                reasons.append("interaction_scope_limited")
    except TimeoutError:
        reasons.append("interaction_timeout")
    except PlaywrightError:
        reasons.append("interaction_failed")
    return Capture(tuple(snapshots), tuple(dict.fromkeys(reasons)), tuple(evidences))
