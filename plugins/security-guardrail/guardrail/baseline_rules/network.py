"""Network baseline rule definitions."""

from .core import terminal_rule
from ..signals import RiskCategory as C

INVALID_URL = terminal_rule("common.network.invalid_url", C.TOOL_CONTRACT, "网络 URL 无效或不受支持")
URL_EMBEDDED_CREDENTIALS = terminal_rule(
    "common.network.url_embedded_credentials", C.CREDENTIAL_EXPOSURE, "包含嵌入式凭据的 URL 已被阻止"
)

TERMINAL_RULES = (INVALID_URL, URL_EMBEDDED_CREDENTIALS)
RULES = TERMINAL_RULES
