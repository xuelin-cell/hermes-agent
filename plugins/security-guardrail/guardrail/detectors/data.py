"""Data-exposure terminal-deny and approval detectors."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING
from urllib.parse import parse_qsl, urlsplit

from ..action import ToolType
from ..baseline_rules import data as rules
from ..baseline_rules import result_for
from .shell.profile import profile_shell_command
from ..signals import BaselineResult, BaselineVerdict

if TYPE_CHECKING:
    from ..action import RuntimeAction
    from ..baseline_rules.selection import ActiveRuleSet

_UPLOAD_HINT_RE = re.compile(
    r"(--data(?:-binary|-raw|-urlencode)?\b|-d\b|--form\b|-F\b|-T\b|--upload-file\b|--post-file\b|"
    r"\bInFile\b|<\s*\S+|@\S+)",
    re.IGNORECASE,
)
_SENSITIVE_COPY_RE = re.compile(r"\b(scp|sftp|rsync)\b", re.IGNORECASE)
_PIPE_TO_NETWORK_RE = re.compile(
    r"\b(cat|type|Get-Content)\b.+\|.+\b(curl|nc|ncat|socat|Invoke-RestMethod|Invoke-WebRequest|iwr|irm)\b",
    re.IGNORECASE | re.DOTALL,
)
_REMOTE_DEST_PATTERN = r"(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]+:[^\s;|&]+"
_HOME_TREE_PATTERN = r"(?:~(?=$|[\s/;|&])|\$HOME(?=$|[\s/;|&])|/home(?=$|[\s/;|&])|/home/[^\s;|&]+)"
_HOME_SOURCE_REMOTE_COPY_RE = re.compile(
    rf"\b(?:scp|rsync)\b(?:(?![;&|\n]).)*\s{_HOME_TREE_PATTERN}"
    rf"(?:(?![;&|\n]).)*\s{_REMOTE_DEST_PATTERN}",
    re.IGNORECASE,
)
_SENSITIVE_HOME_ARCHIVE_RE = re.compile(
    rf"\btar\b(?=[^\n;|&]*(?:\s-c|--create))(?=[^\n;|&]*{_HOME_TREE_PATTERN})"
    r"[^\n;|&]*(?:-[A-Za-z]*f\s+|--file(?:=|\s+))(?P<archive>[^\s;|&]+)",
    re.IGNORECASE,
)
_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN (?:OPENSSH|RSA|DSA|EC|PGP|[A-Z ]*) PRIVATE KEY-----",
    re.IGNORECASE,
)
_MNEMONIC_RE = re.compile(
    r"\b(?:mnemonic|seed(?:\s+phrase)?)\s*[:=]\s*(?:[a-z]{3,12}\s+){11,23}[a-z]{3,12}\b",
    re.IGNORECASE,
)
_HIGH_RISK_SECRET_RE = re.compile(
    r"\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{36,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,})\b"
    r"|\bxox[abprs]-[A-Za-z0-9-]{20,}\b"
    r"|\bnpm_[A-Za-z0-9]{20,}\b"
    r"|\bpypi-[A-Za-z0-9_-]{20,}\b"
    r"|\bAIza[0-9A-Za-z_-]{35}\b"
    r"|(?:api[_-]?key|secret[_-]?key|token|password)\s*[:=]\s*['\"]?[A-Za-z0-9._~+/=-]{20,}",
    re.IGNORECASE,
)
_NETWORK_CLAUSE_RE = re.compile(
    r"https?://|\b(?:curl|wget|scp|sftp|rsync|nc|ncat|socat|Invoke-RestMethod|Invoke-WebRequest|iwr|irm)\b|"
    r"/dev/(?:tcp|udp)/",
    re.IGNORECASE,
)
_MIN_COPY_ARGUMENTS = 2
_KUBECTL_COPY_ARGUMENTS = 3
_OUTBOUND_SECRET_VARIABLE_RE = re.compile(
    r"(?:Authorization\s*:\s*Bearer\s+(?:\$\{?(?:TOKEN|API_KEY|SECRET)\}?|"
    r"\$env:(?:TOKEN|API_KEY|SECRET)|%(?:TOKEN|API_KEY|SECRET)%)|"
    r"(?:-u|--user)(?:=|\s+)[^\s:]+:(?:\$\{?(?:PASSWORD|TOKEN|API_KEY|SECRET)\}?|"
    r"\$env:(?:PASSWORD|TOKEN|API_KEY|SECRET)|%(?:PASSWORD|TOKEN|API_KEY|SECRET)%))",
    re.IGNORECASE,
)
_STRUCTURED_SECRET_PREFIX_RE = re.compile(r"\b(?:ASIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,})\b")
_URL_RE = re.compile(r"https?://[^\s\"'<>\[\]()]+", re.IGNORECASE)
_AWS_ACCESS_KEY_RE = re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")
_AWS_CREDENTIAL_SCOPE_RE = re.compile(
    r"^(?P<access_key>(?:AKIA|ASIA)[0-9A-Z]{16})/\d{8}/[^/]+/[^/]+/aws4_request$",
    re.IGNORECASE,
)
_AWS_DATE_RE = re.compile(r"^\d{8}T\d{6}Z$")
_AWS_SIGNATURE_RE = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)
_DOWNLOAD_CLIENT_RE = re.compile(
    r"(?:^|[;&|\s])(?:curl|wget|Invoke-WebRequest|iwr)(?:\s|$)"
    r"|\b(?:python(?:3)?|py)\b(?=[^;&\n]*(?:download|fetch)[^;&\n]*\.py\b)"
    r"(?=[^;&\n]*--(?:url|uri)\b)(?=[^;&\n]*--(?:out|output|output-file)\b)",
    re.IGNORECASE,
)
_MUTATING_NETWORK_METHOD_RE = re.compile(
    r"(?:^|\s)(?:-X|--request|--method|-Method)(?:=|:|\s+)?(?:POST|PUT|PATCH|DELETE)\b",
    re.IGNORECASE,
)


def detect_terminal_deny(action: RuntimeAction) -> BaselineResult:
    """Detect data exposure actions that must be denied."""
    for detector in (
        detect_home_directory_exfiltration,
        detect_sensitive_archive_exfiltration,
        detect_credential_exfiltration,
    ):
        result = detector(action)
        if result.verdict == BaselineVerdict.TERMINAL_DENY:
            return result

    result = detect_secret_value_exposure(action)
    if result.verdict == BaselineVerdict.TERMINAL_DENY:
        return result

    return BaselineResult.no_signal()


def detect_ask(action: RuntimeAction, *, active_rules: ActiveRuleSet | None = None) -> BaselineResult:
    """Require approval for credential-bearing or file-bearing outbound data."""
    for detector in (detect_secret_value_candidate_ask, detect_external_file_transfer):
        result = detector(action)
        if result.verdict == BaselineVerdict.ASK_REQUIRED and (active_rules is None or active_rules.contains(result.rule_id)):
            return result
    return BaselineResult.no_signal()


def detect_home_directory_exfiltration(action: RuntimeAction) -> BaselineResult:
    """Detect broad home-directory copies to a remote shell destination."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()

    if _HOME_SOURCE_REMOTE_COPY_RE.search(action.normalized_payload):
        return result_for(rules.HOME_DIRECTORY_EXFILTRATION, action, rule_content="home_directory_exfiltration")

    return BaselineResult.no_signal()


def detect_sensitive_archive_exfiltration(action: RuntimeAction) -> BaselineResult:
    """Detect home-directory archives that are copied to remote destinations."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()

    command = action.normalized_payload
    for archive in _home_archive_outputs(command):
        if _archive_copied_to_remote(command, archive):
            return result_for(
                rules.SENSITIVE_ARCHIVE_EXFILTRATION,
                action,
                rule_content="sensitive_archive_exfiltration",
            )

    return BaselineResult.no_signal()


def detect_credential_exfiltration(action: RuntimeAction) -> BaselineResult:
    """Detect common shell patterns that exfiltrate credential-like files."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    if not action.sensitive_path_candidate or not action.network_egress_candidate:
        return BaselineResult.no_signal()

    command = action.normalized_payload
    if _SENSITIVE_COPY_RE.search(command) or _PIPE_TO_NETWORK_RE.search(command) or _UPLOAD_HINT_RE.search(command):
        return result_for(rules.CREDENTIAL_EXFILTRATION, action, rule_content="credential_exfiltration")

    return BaselineResult.no_signal()


def detect_secret_value_exposure(action: RuntimeAction) -> BaselineResult:
    """Detect raw secret values in outbound or searchable payloads."""
    if not _can_expose_payload(action):
        return BaselineResult.no_signal()

    payload = _payload_text(action)
    if not payload:
        return BaselineResult.no_signal()

    if _PRIVATE_KEY_RE.search(payload) or _MNEMONIC_RE.search(payload):
        return result_for(rules.CRITICAL_SECRET_VALUE, action, rule_content="critical_secret_value")

    if _HIGH_RISK_SECRET_RE.search(payload):
        return result_for(rules.SECRET_VALUE_CANDIDATE, action)

    return BaselineResult.no_signal()


def detect_secret_value_candidate_ask(action: RuntimeAction) -> BaselineResult:
    """Require approval only when the suspected secret is in an outbound clause."""
    if not _can_expose_payload(action):
        return BaselineResult.no_signal()
    payload = _ask_payload_text(action)
    payload = _redact_download_presigned_url_credentials(action, payload)
    if payload and (
        _HIGH_RISK_SECRET_RE.search(payload)
        or _OUTBOUND_SECRET_VARIABLE_RE.search(payload)
        or _STRUCTURED_SECRET_PREFIX_RE.search(payload)
    ):
        return result_for(rules.SECRET_VALUE_CANDIDATE, action)
    return BaselineResult.no_signal()


def _redact_download_presigned_url_credentials(action: RuntimeAction, payload: str) -> str:
    """Ignore scoped AWS credentials only when the signed URL is the sole network target."""
    if (
        action.tool_type != ToolType.SHELL
        or not payload
        or _DOWNLOAD_CLIENT_RE.search(payload) is None
        or _UPLOAD_HINT_RE.search(payload)
        or _MUTATING_NETWORK_METHOD_RE.search(payload)
    ):
        return payload

    matches = tuple(_URL_RE.finditer(payload))
    if not matches:
        return payload

    signed_urls: list[tuple[re.Match[str], str]] = []
    canonical_urls: set[str] = set()
    for match in matches:
        url = match.group().replace(r"\&", "&")
        canonical_urls.add(url)
        if _is_aws_presigned_url(url):
            signed_urls.append((match, url))

    # Markdown links can repeat the same URL. A second distinct destination
    # means the signed URL may be data sent elsewhere, so retain the ASK.
    if not signed_urls or len(canonical_urls) != 1:
        return payload

    redacted = payload
    for match, normalized_url in reversed(signed_urls):
        safe_url = _AWS_ACCESS_KEY_RE.sub("<presigned-credential>", normalized_url)
        redacted = redacted[: match.start()] + safe_url + redacted[match.end() :]
    return redacted


def _is_aws_presigned_url(url: str) -> bool:
    """Return whether a URL carries a complete AWS Signature Version 4 query."""
    try:
        parsed = urlsplit(url)
        query = {key.casefold(): value for key, value in parse_qsl(parsed.query, keep_blank_values=True)}
    except ValueError:
        return False

    credential = query.get("x-amz-credential", "")
    credential_scope = _AWS_CREDENTIAL_SCOPE_RE.fullmatch(credential)
    signed_headers = {header.casefold() for header in query.get("x-amz-signedheaders", "").split(";")}
    return (
        parsed.scheme.casefold() == "https"
        and bool(parsed.netloc)
        and query.get("x-amz-algorithm", "").casefold() == "aws4-hmac-sha256"
        and credential_scope is not None
        and _AWS_DATE_RE.fullmatch(query.get("x-amz-date", "")) is not None
        and query.get("x-amz-expires", "").isdigit()
        and "host" in signed_headers
        and _AWS_SIGNATURE_RE.fullmatch(query.get("x-amz-signature", "")) is not None
    )


def detect_external_file_transfer(action: RuntimeAction) -> BaselineResult:
    """Detect explicit local-to-remote file transfer commands."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    for invocation in profile_shell_command(action.normalized_payload).invocations:
        args = invocation.command_args if invocation.canonical_name in {"scp", "rsync"} else invocation.args
        if _is_external_file_transfer(invocation.canonical_name, args):
            return result_for(rules.EXTERNAL_FILE_TRANSFER, action)
    return BaselineResult.no_signal()


def _is_external_file_transfer(command: str, args: tuple[str, ...]) -> bool:
    detected = False
    if command == "scp":
        detected = _copies_local_to_remote(_scp_paths(args))
    elif command == "rsync":
        detected = _copies_local_to_remote(tuple(arg for arg in args if not arg.startswith("-")))
    elif command == "curl":
        detected = _curl_uploads_file(args)
    elif command in {"invoke-restmethod", "invoke-webrequest", "irm", "iwr"}:
        detected = _powershell_uploads_file(args)
    elif command == "aws":
        detected = _cloud_copy_upload(
            _without_aws_global_options(args),
            remote_prefix="s3://",
            command_prefix=("s3",),
        )
    elif command == "gsutil":
        detected = _cloud_copy_upload(_without_transfer_global_options(command, args), remote_prefix="gs://")
    elif command == "gcloud":
        detected = _cloud_copy_upload(
            _without_transfer_global_options(command, args), remote_prefix="gs://", command_prefix=("storage",)
        )
    elif command == "az":
        stripped = _without_transfer_global_options(command, args)
        detected = tuple(arg.casefold() for arg in stripped[:3]) == ("storage", "blob", "upload") and any(
            arg.casefold() in {"-f", "--file"} or arg.casefold().startswith("--file=") for arg in stripped[3:]
        )
    elif command == "kubectl":
        detected = _kubectl_uploads(args)
    elif command == "azcopy":
        detected = _copies_local_to_web(args)
    elif command == "rclone":
        detected = _rclone_uploads(args)
    return detected


def _scp_paths(args: tuple[str, ...]) -> tuple[str, ...]:
    """Extract SCP operands without mistaking option values for local sources."""
    paths: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index].strip("\"'")
        if arg == "--":
            paths.extend(value.strip("\"'") for value in args[index + 1 :])
            break
        if arg.startswith("-"):
            # SCP short options are case-sensitive (-P takes a port; -p is a flag).
            for offset, option in enumerate(arg[1:], start=1):
                if option in "cDFiJloPSX":
                    if offset == len(arg) - 1:
                        index += 1
                    break
        else:
            paths.append(arg)
        index += 1
    return tuple(paths)


def _copies_local_to_remote(args: tuple[str, ...]) -> bool:
    positional = tuple(arg.strip("\"'") for arg in args)
    return len(positional) >= _MIN_COPY_ARGUMENTS and _is_remote_shell_path(positional[-1]) and any(
        not _is_remote_shell_path(source) for source in positional[:-1]
    )


def _curl_uploads_file(args: tuple[str, ...]) -> bool:
    for index, arg in enumerate(args):
        option, separator, value = arg.partition("=")
        if option.casefold() in {"-t", "--upload-file"}:
            payload = value if separator else (args[index + 1] if index + 1 < len(args) else "")
            return bool(payload and payload != "-")
        if option.casefold() in {
            "-d",
            "--data",
            "--data-ascii",
            "--data-binary",
            "--data-urlencode",
            "--form",
        } or option == "-F":
            payload = value if separator else (args[index + 1] if index + 1 < len(args) else "")
            payload = payload.strip().strip("\"'`")
            if _curl_payload_references_file(option, payload):
                return True
    return False


def _curl_payload_references_file(option: str, payload: str) -> bool:
    if payload.startswith("@"):
        return len(payload) > 1
    if option.casefold() in {"--data-urlencode", "--form"} or option == "-F":
        return re.fullmatch(r"[^@=<\s]+(?:=@|@|=<|<)\S+", payload) is not None
    return False


def _powershell_uploads_file(args: tuple[str, ...]) -> bool:
    for index, arg in enumerate(args):
        option, separator, value = re.split(r"([:=])", arg, maxsplit=1) if re.search(r"[:=]", arg) else (arg, "", "")
        if option.casefold() != "-infile":
            continue
        return bool(value) if separator else index + 1 < len(args)
    return False


def _without_aws_global_options(args: tuple[str, ...]) -> tuple[str, ...]:
    options_with_value = {"--endpoint-url", "--output", "--profile", "--region"}
    flags = {"--debug", "--no-cli-pager", "--no-sign-request"}
    index = 0
    while index < len(args):
        option, separator, _value = args[index].casefold().partition("=")
        if option in flags:
            index += 1
            continue
        if option not in options_with_value:
            break
        index += 1 if separator else 2
    return args[index:]


def _without_transfer_global_options(command: str, args: tuple[str, ...]) -> tuple[str, ...]:
    options_with_value = {
        "az": {"--subscription", "--tenant"},
        "gcloud": {"--account", "--configuration", "--project"},
        "gsutil": {"-i", "-o"},
        "kubectl": {"--context", "--kubeconfig", "--namespace", "-n"},
    }.get(command, set())
    flags = {
        "az": {"--debug", "--only-show-errors", "--verbose"},
        "gcloud": {"--quiet"},
        "gsutil": {"-m"},
        "kubectl": {"--insecure-skip-tls-verify"},
    }.get(command, set())
    index = 0
    while index < len(args):
        option, separator, _value = args[index].casefold().partition("=")
        if option in flags:
            index += 1
            continue
        if option not in options_with_value:
            break
        index += 1 if separator else 2
    return args[index:]


def _kubectl_uploads(args: tuple[str, ...]) -> bool:
    stripped = _without_transfer_global_options("kubectl", args)
    if tuple(arg.casefold() for arg in stripped[:1]) != ("cp",) or len(stripped) < _KUBECTL_COPY_ARGUMENTS:
        return False
    source, destination = stripped[-2:]
    return not _is_kubernetes_remote_path(source) and _is_kubernetes_remote_path(destination)


def _is_kubernetes_remote_path(value: str) -> bool:
    if _is_windows_absolute(value):
        return False
    return re.fullmatch(r"(?:[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+:.+", value) is not None


def _copies_local_to_web(args: tuple[str, ...]) -> bool:
    lowered = tuple(arg.casefold() for arg in args)
    if not lowered or lowered[0] not in {"copy", "sync"} or len(args) < _MIN_COPY_ARGUMENTS + 1:
        return False
    source, destination = args[-2:]
    return not source.casefold().startswith(("http://", "https://")) and destination.casefold().startswith(
        ("http://", "https://")
    )


def _rclone_uploads(args: tuple[str, ...]) -> bool:
    if (
        not args
        or args[0].casefold() not in {"copy", "copyto", "move", "sync"}
        or len(args) < _MIN_COPY_ARGUMENTS + 1
    ):
        return False
    source, destination = args[-2:]
    return not _is_remote_shell_path(source) and _is_remote_shell_path(destination)


def _cloud_copy_upload(
    args: tuple[str, ...],
    *,
    remote_prefix: str,
    command_prefix: tuple[str, ...] = (),
) -> bool:
    lowered = tuple(arg.casefold() for arg in args)
    if command_prefix and lowered[: len(command_prefix)] != command_prefix:
        return False
    offset = len(command_prefix)
    if len(args) < offset + 3 or lowered[offset] not in {"cp", "sync"}:
        return False
    source, destination = args[-2:]
    return not source.casefold().startswith(remote_prefix) and destination.casefold().startswith(remote_prefix)


def _is_remote_shell_path(value: str) -> bool:
    if _is_windows_absolute(value):
        return False
    return re.fullmatch(r"(?:[^@\s:]+@)?[A-Za-z0-9_.-]+:.+", value) is not None


def _is_windows_absolute(value: str) -> bool:
    return re.match(r"^[A-Za-z]:[/\\]", value) is not None


def _can_expose_payload(action: RuntimeAction) -> bool:
    return action.network_egress_candidate or action.tool_type == ToolType.NETWORK


def _payload_text(action: RuntimeAction) -> str:
    values = [action.normalized_payload]
    for key in (
        "query",
        "q",
        "search",
        "url",
        "uri",
        "href",
        "body",
        "body_preview",
        "bodyPreview",
        "payload",
        "data",
        "json",
        "headers",
        "authorization",
        "Authorization",
    ):
        value = action.tool_input.get(key)
        if isinstance(value, str):
            values.append(value)
    return "\n".join(values)


def _ask_payload_text(action: RuntimeAction) -> str:
    """Return only payload regions that are part of an outbound operation."""
    if action.tool_type == ToolType.NETWORK:
        return _payload_text(action)
    if action.tool_type != ToolType.SHELL:
        return ""
    clauses = re.split(r"(?:&&|\|\||[;\n])", action.normalized_payload)
    return "\n".join(clause for clause in clauses if _NETWORK_CLAUSE_RE.search(clause))


def _home_archive_outputs(command: str) -> tuple[str, ...]:
    archives: list[str] = []
    for match in _SENSITIVE_HOME_ARCHIVE_RE.finditer(command):
        archive = _clean_shell_token(match.group("archive"))
        if archive:
            archives.append(archive)
    return tuple(dict.fromkeys(archives))


def _archive_copied_to_remote(command: str, archive: str) -> bool:
    archive_pattern = re.escape(archive)
    return (
        re.search(
            rf"\b(?:scp|rsync)\b(?:(?![;&|\n]).)*(?:^|\s){archive_pattern}(?=$|\s)"
            rf"(?:(?![;&|\n]).)*{_REMOTE_DEST_PATTERN}",
            command,
            re.IGNORECASE,
        )
        is not None
    )


def _clean_shell_token(value: str) -> str:
    return value.strip().strip("\"'`").strip(";,|&()[]{}").strip()
