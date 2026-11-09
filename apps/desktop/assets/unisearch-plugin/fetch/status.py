"""Small Builtin result wire contract; safe to import before parser preparation."""

_REASONS = frozenset({
    "visibility_unresolved",
    "empty_content",
    "access_page",
    "http_error",
    "target_route_unverified",
    "thin_content",
    "main_content_missing",
    "repository_overview_unverified",
    "dynamic_content_pending",
    "render_timeout",
    "render_unavailable",
    "render_no_usable_content",
    "budget_exhausted",
    "extract_failed",
    "output_unavailable",
    "policy_blocked",
    "interaction_required",
    "pagination_remaining",
    "interaction_limit",
    "interaction_scope_limited",
    "interaction_timeout",
    "interaction_failed",
    "interaction_navigation",
    "interaction_blocked",
})


# 传输只允许稳定的小字段，未知状态不能冒充已经评估成功。
def result_status(value: dict) -> dict:
    status = value.get("fetch_status")
    if value.get("error") or not value.get("content"):
        status = "unavailable"
    if status not in {"usable", "partial", "unavailable"}:
        status = "unavailable"
    reasons = value.get("reasons", ())
    if not isinstance(reasons, (list, tuple)):
        reasons = ()
    result = {
        "fetch_status": status,
        "reasons": list(
            dict.fromkeys(r for r in reasons if isinstance(r, str) and r in _REASONS)
        )[:4],
    }
    if status != "unavailable" and (
        value.get("engine") not in {"http", "chromium"}
        or status == "partial"
        and not result["reasons"]
    ):
        result["fetch_status"] = "unavailable"
        result["reasons"] = ["extract_failed"]
    if result["fetch_status"] == "unavailable" and not result["reasons"]:
        result["reasons"] = ["extract_failed"]
    if value.get("engine") in {"http", "chromium"}:
        result["engine"] = value["engine"]
    if result["fetch_status"] == "partial" and any(
        r.startswith("interaction_")
        or r in {"pagination_remaining", "dynamic_content_pending", "visibility_unresolved", "main_content_missing", "repository_overview_unverified"}
        for r in result["reasons"]
    ):
        result["browser_followup"] = {
            "needed": True,
            "guidance": "已取得部分正文，但尚不能确认覆盖全部内容。若任务需要更多内容，请使用当前会话实际可用的浏览器工具检查页面，按需要滚动、展开或逐页读取，每步保留已读内容并核对目标；不要反复对同一地址重新抓取来代替交互。没有可用浏览器工具时说明限制，不声称已读完。",
        }
    return result
