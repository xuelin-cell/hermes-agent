"""Data-exposure baseline rule definitions."""

from .core import ask_rule, terminal_rule
from ..signals import RiskCategory as C

HOME_DIRECTORY_EXFILTRATION = terminal_rule(
    "common.data.home_directory_exfiltration", C.CREDENTIAL_EXPOSURE, "主目录复制到远程目标已被阻止"
)
SENSITIVE_ARCHIVE_EXFILTRATION = terminal_rule(
    "common.data.sensitive_archive_exfiltration", C.CREDENTIAL_EXPOSURE, "包含主目录的归档文件外传已被阻止"
)
CREDENTIAL_EXFILTRATION = terminal_rule(
    "common.data.credential_exfiltration", C.CREDENTIAL_EXPOSURE, "凭据类文件外传已被阻止"
)
CRITICAL_SECRET_VALUE = terminal_rule(
    "common.data.critical_secret_value", C.CREDENTIAL_EXPOSURE, "关键密钥或私密值暴露已被阻止"
)

SECRET_VALUE_CANDIDATE = ask_rule(
    "common.data.secret_value_candidate",
    C.CREDENTIAL_EXPOSURE,
    "向网络目标发送疑似密钥或凭据",
)
EXTERNAL_FILE_TRANSFER = ask_rule(
    "common.data.external_file_transfer",
    C.DATA_EXFILTRATION,
    "将本地文件或内容发送到外部目标",
)

TERMINAL_RULES = (
    HOME_DIRECTORY_EXFILTRATION,
    SENSITIVE_ARCHIVE_EXFILTRATION,
    CREDENTIAL_EXFILTRATION,
    CRITICAL_SECRET_VALUE,
)
ASK_RULES = (SECRET_VALUE_CANDIDATE, EXTERNAL_FILE_TRANSFER)
RULES = (*TERMINAL_RULES, *ASK_RULES)
