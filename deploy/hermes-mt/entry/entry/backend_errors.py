"""Public failure categories; upstream response bodies stay in server logs."""
import re


def cube_failure_reason(status: int, message: str) -> str:
    if re.search(r"\b130408\b", message):
        return "sandbox_node_unhealthy"
    if "PermissionError" in message or "Permission denied" in message:
        return "sandbox_permission_denied"
    if status in (408, 504) or "context deadline exceeded" in message:
        return "sandbox_operation_timeout"
    return "sandbox_unavailable"
