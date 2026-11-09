"""Shared loading policy for HTML assessment and live browser observation."""

import json
from itertools import chain
import re

from bs4 import Comment, NavigableString
from .visibility import StaticVisibility, BROWSER_VISIBILITY

ROOT_SELECTOR = "main, article, [role=main]"
EXCLUDED_SELECTOR = (
    "head,script,style,noscript,template,nav,aside,footer,form,pre,code,blockquote,q,"
    "button,summary,[role=dialog],[role=button]"
)
CONTEXT_EXCLUDED_SELECTOR = (
    "head,script,style,noscript,template,nav,aside,footer,form,button,summary,"
    "[role=dialog],[role=button]"
)
LOADING_PATTERN = r"^(?:loading[.…。]*|please wait|加载中[.。…]*|正在加载[.。…]*)$"
INLINE_TEXT_TAGS = (
    "span",
    "strong",
    "em",
    "b",
    "i",
    "u",
    "small",
    "a",
    "mark",
    "s",
    "label",
)
HEADING_TAGS = ("h1", "h2", "h3", "h4", "h5", "h6")
BLOCK_TEXT_TAGS = (
    "p",
    "div",
    "section",
    "article",
    "main",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "table",
    "blockquote",
    "pre",
    "hr",
    *HEADING_TAGS,
)
LOADING_TEXT = re.compile(LOADING_PATTERN, re.I)


# 只收主内容及其有效祖先的加载证据；静态阶段仅判断HTML内可识别的隐藏信息。
def has_loading_content(soup, *, visibility=None) -> bool:
    excluded_ids = {id(node) for node in soup.select(EXCLUDED_SELECTOR)}
    context_excluded_ids = {id(node) for node in soup.select(CONTEXT_EXCLUDED_SELECTOR)}

    visible = visibility or StaticVisibility()
    text_cache, context_cache = {}, {}

    # 引用不能单独充当加载证据，但可见引用仍参与正常句子的语境。
    def eligible(node):
        return visible(node) is not False and not any(
            id(parent) in excluded_ids for parent in [node, *node.parents]
        )

    # 确认正文和不确定性分开返回；未知文字不能用于否定真实加载提示。
    def context_text(node):
        key = id(node)
        if key in text_cache:
            return text_cache[key]
        parts, uncertain = [], False
        nodes = (
            [node]
            if isinstance(node, NavigableString)
            else chain((node,), node.descendants)
        )
        for item in nodes:
            parent = item.parent if isinstance(item, NavigableString) else item
            if (
                isinstance(item, Comment)
                or visible(parent) is False
                or any(
                    id(ancestor) in context_excluded_ids
                    for ancestor in [parent, *parent.parents]
                )
            ):
                continue
            if visible(parent) is None:
                # 未知块即使为空也可能分隔语境，不能擅自确定相邻词属于同一句。
                uncertain |= (
                    bool(str(item).strip())
                    if isinstance(item, NavigableString)
                    else item.name in (*BLOCK_TEXT_TAGS, "br")
                )
            elif isinstance(item, NavigableString):
                parts.append(str(item))
            elif item.name == "br":
                parts.append(" ")
        text_cache[key] = ("".join(parts), uncertain)
        return text_cache[key]

    # 隐藏块不切断可见句子；正常可见块仍分隔独立加载提示。
    def block_boundary(node):
        return node.name in BLOCK_TEXT_TAGS and (
            visible(node) is True or bool(context_text(node)[0].strip())
        )

    roots = [node for node in soup.select(ROOT_SELECTOR) if eligible(node)]
    if not roots:
        roots = [soup.body or soup]

    # 普通加载文字和进度条只能来自主内容；祖先busy另外检查，不扩散到兄弟区域。
    def inside(node):
        return any(
            any(parent is root for parent in [node, *node.parents]) for root in roots
        )

    for node in soup.select("[aria-busy], [role=progressbar]"):
        if not eligible(node):
            continue
        covers = inside(node) or any(
            any(parent is node for parent in root.parents) for root in roots
        )
        if covers and str(node.get("aria-busy", "")).strip().lower() == "true":
            return True
        if inside(node) and node.get("role") == "progressbar":
            return True

    # 行内词组成完整语境，块级兄弟分隔独立提示；普通标题不是状态，显式status除外。
    def text_is_loading(text):
        node, branch = text.parent, text
        while node.name in INLINE_TEXT_TAGS and node.get("role") != "status":
            parent = node.parent
            if parent is None or parent.name == "[document]":
                break
            branch, node = node, parent
        if node.name in HEADING_TAGS and node.get("role") != "status":
            return False
        if not inside(text.parent):
            return False
        key = id(node)
        if key not in context_cache:
            groups, group = [], []
            for peer in node.children:
                if block_boundary(peer):
                    if group:
                        groups.append(group)
                        group = []
                else:
                    group.append(peer)
            if group:
                groups.append(group)
            matches = {}
            for peers in groups:
                pieces = [context_text(peer) for peer in peers]
                context = "".join(text for text, _ in pieces)
                matched = any(uncertain for _, uncertain in pieces) or bool(
                    LOADING_TEXT.fullmatch(context.strip())
                )
                matches.update((id(peer), matched) for peer in peers)
            context_cache[key] = matches
        return context_cache[key].get(id(branch), False)

    return any(
        not isinstance(text, Comment)
        and str(text).strip()
        and eligible(text.parent)
        and text_is_loading(text)
        for text in soup.find_all(string=True)
    )


# JS与静态解析共用选择器和表达式；浏览器额外使用计算样式，不以布局盒排除display:contents祖先。
BROWSER_LOADING = r"""() => {
    const policy = __POLICY__;
    const pattern = new RegExp(policy.text, 'i');
    // 缓存只属于此次同步采样；DOM变化后的下一次调用重新计算。
    const {visible} = (__VISIBILITY__)();
    const contexts = new WeakMap();
    // 证据排除与可见语境分开：代码/引用中的文字不能产生状态，但保留句子含义。
    const eligible = node => visible(node) && !node.closest(policy.excluded);
    // 遍历文字叶节点，不把隐藏兄弟/后代或脚本内容拼入语境。
    const contextText = node => {
        let text = '';
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        let item = node;
        do {
            const parent = item.nodeType === Node.TEXT_NODE ? item.parentElement : item;
            if (item.nodeType !== Node.TEXT_NODE && item.nodeType !== Node.ELEMENT_NODE) continue;
            if (!visible(parent) || parent.closest(policy.contextExcluded)) continue;
            if (item.nodeType === Node.TEXT_NODE) text += item.textContent;
            else if (item.localName === 'br') text += ' ';
        } while ((item = walker.nextNode()));
        return text;
    };
    // 隐藏块不拆句，普通可见块继续分隔提示。
    const isBlock = node => node.nodeType === Node.ELEMENT_NODE && policy.blocks.includes(node.localName) &&
        (visible(node) || !!contextText(node).trim());
    let roots = [...document.querySelectorAll(policy.roots)].filter(eligible);
    if (!roots.length) roots = [document.body || document.documentElement];
    const inside = e => roots.some(root => root.contains(e));
    // 相邻行内词属于同一语境，块级兄弟不吞掉独立加载提示。
    const textIsLoading = n => {
        if (!n.textContent.trim() || !eligible(n.parentElement)) return false;
        let e = n.parentElement, branch = n;
        while (policy.inline.includes(e.localName) && e.getAttribute('role') !== 'status' && e.parentElement) {
            branch = e;
            e = e.parentElement;
        }
        if (policy.headings.includes(e.localName) && e.getAttribute('role') !== 'status') return false;
        if (!inside(n.parentElement)) return false;
        if (!contexts.has(e)) {
            const groups = [], matches = new WeakMap();
            let group = [];
            for (const peer of e.childNodes) {
                if (isBlock(peer)) {
                    if (group.length) groups.push(group);
                    group = [];
                } else group.push(peer);
            }
            if (group.length) groups.push(group);
            for (const peers of groups) {
                const matched = pattern.test(peers.map(contextText).join('').trim());
                for (const peer of peers) matches.set(peer, matched);
            }
            contexts.set(e, matches);
        }
        return contexts.get(e).get(branch) || false;
    };
    let busy = false;
    for (const e of document.querySelectorAll('[aria-busy],[role=progressbar]')) {
        if (!eligible(e)) continue;
        const covers = inside(e) || roots.some(root => e.contains(root));
        if ((covers && (e.getAttribute('aria-busy') || '').trim().toLowerCase() === 'true') ||
            (inside(e) && e.getAttribute('role') === 'progressbar')) { busy = true; break; }
    }
    if (!busy) {
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const n = walker.currentNode;
            if (textIsLoading(n)) { busy = true; break; }
        }
    }
    return {busy, textIsLoading, visible, roots};
}""".replace("__VISIBILITY__", BROWSER_VISIBILITY).replace(
    "__POLICY__",
    json.dumps(
        {
            "roots": ROOT_SELECTOR,
            "excluded": EXCLUDED_SELECTOR,
            "contextExcluded": CONTEXT_EXCLUDED_SELECTOR,
            "text": LOADING_PATTERN,
            "inline": INLINE_TEXT_TAGS,
            "headings": HEADING_TAGS,
            "blocks": BLOCK_TEXT_TAGS,
        }
    ),
)
