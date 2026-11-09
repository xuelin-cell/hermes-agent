"""One snapshot's visibility facts; static inference is not computed CSS."""

import re

_DISPLAY_VALUES = frozenset(
    {
        "none",
        "contents",
        "block",
        "inline",
        "flow",
        "flow-root",
        "flex",
        "grid",
        "table",
        "ruby",
        "list-item",
        "inline-block",
        "inline-flex",
        "inline-grid",
        "inline-table",
        "table-row-group",
        "table-header-group",
        "table-footer-group",
        "table-row",
        "table-cell",
        "table-column-group",
        "table-column",
        "table-caption",
        "ruby-base",
        "ruby-text",
        "ruby-base-container",
        "ruby-text-container",
        "math",
    }
)
_GLOBAL_VALUES = frozenset({"inherit", "initial", "unset", "revert", "revert-layer"})


# 仅在引号和函数外按分号分隔，其他属性内的CSS文本不能伪造隐藏声明。
def _style_declarations(style):
    style = re.sub(r"/\*.*?\*/", " ", style, flags=re.S)
    start, depth, quote, escaped = 0, 0, "", False
    for index, char in enumerate(style):
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif quote:
            if char == quote:
                quote = ""
        elif char in "\"'":
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth = max(0, depth - 1)
        elif char == ";" and depth == 0:
            yield style[start:index]
            start = index + 1
    yield style[start:]


# 识别确定有效的简单值；变量依赖记为unknown，不假装静态HTML已算出最终样式。
def _visibility_value(key, value):
    if value in _GLOBAL_VALUES:
        return value
    if key == "opacity":
        if re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?", value):
            return "zero" if float(value.rstrip("%")) <= 0 else "positive"
    elif key == "content-visibility":
        if value in {"visible", "hidden", "auto"}:
            return value
    elif key == "visibility":
        if value in {"visible", "hidden", "collapse"}:
            return value
    elif key == "display" and value in _DISPLAY_VALUES:
        return value
    elif key == "display":
        words = value.split()
        tokens = set(words)
        outside = tokens & {"block", "inline"}
        inside = tokens & {"flow", "flow-root", "flex", "grid", "table", "ruby"}
        if len(words) == len(tokens):
            if len(outside) == len(inside) == 1 and len(tokens) == 2:
                return value
            if (
                "list-item" in tokens
                and tokens <= {"list-item", "block", "inline", "flow", "flow-root"}
                and len(outside) <= 1
                and len(inside) <= 1
            ):
                return value
    # 厂商扩展、转义标识符及运行时变量无法静态确定，不能据旧none确认隐藏。
    if "\\" in value or re.fullmatch(r"-[a-z][a-z0-9-]*", value):
        return "unknown"
    if re.fullmatch(r"(?:var|env)\(.+\)", value):
        return "unknown"
    return None


# 空/非法值不参与覆盖；仅在有效声明之间比较先后顺序和important。
def _inline_visibility(style):
    values = {}
    for declaration in _style_declarations(style):
        key, separator, value = declaration.partition(":")
        key = key.strip().lower()
        if not separator or key not in {
            "display",
            "visibility",
            "opacity",
            "content-visibility",
        }:
            continue
        value = value.strip().lower()
        important = bool(re.search(r"!\s*important\s*$", value))
        value = " ".join(re.sub(r"!\s*important\s*$", "", value).split())
        value = _visibility_value(key, value)
        if value is not None and (key not in values or important or not values[key][1]):
            values[key] = (value, important)
    return {key: value for key, (value, _) in values.items()}


class StaticVisibility:
    # 节点身份缓存只属于当前HTML；不跨页面或DOM变化复用。
    def __init__(self):
        self._styles = {}
        self._nodes = {}

    # 同一种声明只解释一次，避免每个文字节点重复解析。
    def styles(self, node):
        value = node.get("style", "")
        if value not in self._styles:
            self._styles[value] = _inline_visibility(value)
        return self._styles[value]

    # hidden与CSS冲突按可解释声明处理；aria-hidden不是视觉隐藏。
    def _resolve(self, node):
        visibility = None
        uncertain = False
        for parent in [node, *node.parents]:
            # 原生隐藏输入不会因CSS显示声明而成为可读控件。
            if (
                parent.name == "input"
                and str(parent.get("type", "")).lower() == "hidden"
            ):
                return False
            styles = self.styles(parent)
            display = styles.get("display")
            if (
                display == "none"
                or styles.get("opacity") == "zero"
                or styles.get("content-visibility") == "hidden"
            ):
                return False
            # 未打开dialog的默认隐藏可被显式display覆盖，与hidden使用同一声明规则。
            if parent.has_attr("hidden") or (
                parent.name == "dialog" and not parent.has_attr("open")
            ):
                if (
                    str(parent.get("hidden", "")).lower() == "until-found"
                    or not display
                ):
                    return False
                if display in {"unknown", "inherit", "unset", "revert", "revert-layer"}:
                    uncertain = True
            if parent.name == "details" and not parent.has_attr("open"):
                summary = parent.find("summary", recursive=False)
                if node is not parent and not any(
                    a is summary for a in [node, *node.parents]
                ):
                    return False
            uncertain |= any(
                styles.get(key) == "unknown"
                for key in ("display", "opacity", "content-visibility")
            )
            value = styles.get("visibility")
            if (
                visibility is None
                and value
                and value not in {"inherit", "unset", "revert", "revert-layer"}
            ):
                visibility = "visible" if value == "initial" else value
        if visibility in {"hidden", "collapse"}:
            return False
        return None if uncertain or visibility == "unknown" else True

    # 身份键不会触发BeautifulSoup子树哈希。
    def __call__(self, node):
        key = id(node)
        if key not in self._nodes:
            self._nodes[key] = self._resolve(node)
        return self._nodes[key]


# 加载、采样与正文投影共享计算状态，包含可恢复的子元素visibility。
BROWSER_VISIBILITY = r"""() => {
    const styles = new WeakMap(), visibility = new WeakMap();
    const getStyle = e => {
        if (!styles.has(e)) styles.set(e, getComputedStyle(e));
        return styles.get(e);
    };
    const resolve = node => {
        if (['hidden','collapse'].includes(getStyle(node).visibility)) return false;
        for (let e = node; e; e = e.parentElement) {
            const style = getStyle(e);
            if (style.display === 'none' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false;
            if (e.localName === 'details' && !e.open && e !== node) {
                const summary = [...e.children].find(c => c.localName === 'summary');
                if (!summary || !summary.contains(node)) return false;
            }
        }
        return true;
    };
    const visible = e => {
        if (!visibility.has(e)) visibility.set(e, resolve(e));
        return visibility.get(e);
    };
    return {visible};
}"""
