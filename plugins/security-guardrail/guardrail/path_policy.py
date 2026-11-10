"""Path classification helpers for guardrail detectors.

These helpers do not touch the filesystem, expand users, resolve symlinks, or
inspect mounts. Current-user classifiers read the process's ``APPDATA`` and
``LOCALAPPDATA`` values to bind Windows data paths to the active user.
"""
from __future__ import annotations

from .runtime import execution_environment

import re

_WINDOWS_HOST_ROOT_RE = re.compile(r"^(?:[a-z]:|/mnt/[a-z])/", re.IGNORECASE)
_WINDOWS_ABSOLUTE_PATH_RE = re.compile(r"^[a-z]:/", re.IGNORECASE)
_WINDOWS_DRIVE_ROOT_RE = re.compile(r"^[a-z]:$", re.IGNORECASE)
WINDOWS_PRODUCT_DATA_DIRS = ("hexagent-lite", "hexagent", "uniwork")
WINDOWS_PRODUCT_DATA_DIR_PATTERN = (
    "(?:" + "|".join(re.escape(name) for name in WINDOWS_PRODUCT_DATA_DIRS) + ")"
)
_APP_DIR_ENV_REFERENCE_RE = re.compile(
    r"%hexagent_app_dir%|\$env:hexagent_app_dir|\$\{env:hexagent_app_dir\}|"
    r"\$hexagent_app_dir|\$\{hexagent_app_dir\}",
    re.IGNORECASE,
)
_WINDOWS_SYSTEM_PATH_RE = re.compile(
    r"(?:^|[\s'\"`=])(?:[a-z]:|/mnt/[a-z])/"
    r"(?:windows|program files(?: \(x86\))?|programdata)(?:/|$|[\s'\"`;|&])",
    re.IGNORECASE,
)
_WINDOWS_CREDENTIAL_PATH_RE = re.compile(
    r"(?:^|[\s'\"`=])(?:[a-z]:|/mnt/[a-z])/"
    r"(?:users/[^/]+/)?appdata/(?:roaming|local)/microsoft/(?:credentials|protect)(?:/|$|[\s'\"`;|&])"
    r"|(?:^|[\s'\"`=])(?:[a-z]:|/mnt/[a-z])/windows/system32/config/(?:sam|system|security)(?:$|[\s'\"`;|&])"
    r"|(?:^|/)ntuser\.dat(?:$|[\s'\"`;|&])",
    re.IGNORECASE,
)
_WINDOWS_HEXAGENT_DATA_PATH_RE = re.compile(
    r"(?:"
    r"(?:[a-z]:|/mnt/[a-z])/users/[^/]+/appdata/roaming|"
    r"%appdata%|\$env:appdata|\$\{env:appdata\}|\$appdata|\$\{appdata\}"
    rf")/{WINDOWS_PRODUCT_DATA_DIR_PATTERN}/"
    r"(?:config\.json|permissions\.json|plugins_meta\.json|plugin_secrets\.json|"
    r"security/(?:runtimes\.json|sensitive-protection\.json|settings\.json))",
    re.IGNORECASE,
)
_WINDOWS_ELECTRON_SESSION_WORKSPACE_RE = re.compile(
    rf"^[a-z]:/users/[^/]+/appdata/roaming/{WINDOWS_PRODUCT_DATA_DIR_PATTERN}/sessions/[^/]+$",
    re.IGNORECASE,
)
_WINDOWS_USER_SESSIONS_PATH_RE = re.compile(
    rf"^[a-z]:/users/[^/*?\[\]]+/appdata/roaming/{WINDOWS_PRODUCT_DATA_DIR_PATTERN}/sessions(?:/.*)?$",
    re.IGNORECASE,
)
_VM_SESSION_WORKSPACE_RE = re.compile(r"^/sessions/[^/]+$", re.IGNORECASE)
_MAC_SYSTEM_PATH_RE = re.compile(
    r"(?:^|[\s'\"`=])(?:/system|/library|/applications|/private/etc)(?:/|$|[\s'\"`;|&])"
    r"|(?:^|[\s'\"`=])/users/[^/]+/library/launchagents(?:/|$|[\s'\"`;|&])"
    r"|(?:^|[\s'\"`=])/library/(?:launchdaemons|privilegedhelpertools|startupitems)(?:/|$|[\s'\"`;|&])",
    re.IGNORECASE,
)
_MAC_CREDENTIAL_PATH_RE = re.compile(
    r"^(?:~|/users/[^/]+)/library/keychains(?:/|$)"
    r"|^/library/keychains(?:/|$)"
    r"|^/users/[^/]+/library/group containers/[^/]*keychain",
    re.IGNORECASE,
)
_BROWSER_CREDENTIAL_PATH_RE = re.compile(
    r"(?:chrome|chromium|edge|brave).*/user data/.*/login data$"
    r"|firefox/profiles/.*/(?:logins\.json|key4\.db)$",
    re.IGNORECASE,
)
_VM_SESSION_MOUNT_RE = re.compile(r"^/sessions/[^/]+/mnt(?:/|$)", re.IGNORECASE)
_VM_SESSION_MOUNT_ROOT_RE = re.compile(r"^/sessions/[^/]+/mnt(?:/[^/]+)?$", re.IGNORECASE)
_VM_WINDOWS_DRIVE_MOUNT_RE = re.compile(r"^/mnt/[a-z](?:/|$)", re.IGNORECASE)
_VM_WINDOWS_DRIVE_MOUNT_ROOT_RE = re.compile(r"^/mnt/[a-z]$", re.IGNORECASE)
_VM_LIMA_HOST_MOUNT_RE = re.compile(r"^/mnt/hostmnt(?:/|$)", re.IGNORECASE)
_VM_LIMA_HOST_MOUNT_ROOT_RE = re.compile(r"^/mnt/hostmnt(?:/home)?$", re.IGNORECASE)
_VM_HOST_SENSITIVE_ALIAS_RE = re.compile(
    r"(?:^|/)(?:"
    r"\.ssh/(?:authorized_keys|id_(?:rsa|dsa|ecdsa|ed25519))|"
    r"\.gnupg(?:/|$)|\.aws/credentials(?:$|/)|\.kube/config(?:$|/)|\.docker/config\.json$|"
    r"library/(?:keychains|group containers/[^/]*keychain)(?:/|$)|"
    r"appdata/(?:roaming|local)/microsoft/(?:credentials|protect)(?:/|$)|"
    r"(?:windows/)?system32/config/(?:sam|system|security)$|"
    r"(?:chrome|chromium|edge|brave).*/user data/.*/login data$|"
    r"firefox/profiles/.*/(?:logins\.json|key4\.db)$"
    r")",
    re.IGNORECASE,
)
_VM_CONTROL_SOCKET_RE = re.compile(
    r"^/(?:var/)?run/(?:docker\.sock|containerd/containerd\.sock|wsl/[^/]*_interop|lima[^/]*\.sock)$",
    re.IGNORECASE,
)
_LINUX_SENSITIVE_EXACT = frozenset(
    {
        "/etc/passwd",
        "/etc/shadow",
        "/etc/sudoers",
    }
)
_LINUX_SENSITIVE_PREFIXES = (
    "/etc/sudoers.d/",
)
_LINUX_CRITICAL_SYSTEM_PREFIXES = (
    *_LINUX_SENSITIVE_PREFIXES,
    "/etc/ssh/",
    "/etc/systemd/",
    "/usr/bin/",
    "/usr/lib/systemd/",
    "/bin/",
    "/sbin/",
    "/boot/",
    "/lib/",
    "/lib64/",
)
_SENSITIVE_BASENAMES = frozenset(
    {
        ".env",
        ".netrc",
        ".npmrc",
        ".pypirc",
        "authorized_keys",
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
        "known_hosts",
        "credentials",
        "credentials.json",
        "serviceaccountkey.json",
        "service_account_key.json",
        "wallet.dat",
    }
)
_ENV_TEMPLATE_BASENAMES = frozenset({".env.example", ".env.sample", ".env.template", ".env.dist", ".env.defaults"})
_SENSITIVE_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".kdbx")
_SENSITIVE_SEGMENTS = frozenset({".ssh", ".gnupg", ".aws", ".azure", ".gcp", ".kube"})
_SENSITIVE_GLOB_TERMS = ("credential", "secret", "api_key", "apikey", "private-key", "private_key")
_USER_HOME_PERSISTENCE_RE = re.compile(
    r"^(?:~|\$home|\$\{home\}|%userprofile%|\$env:userprofile|/root|/(?:home|users)/[^/]+|[a-z]:/users/[^/]+)"
    r"/(?:\.(?:bashrc|bash_profile|zshrc|profile)|\.ssh/authorized_keys|"
    r"\.config/fish/config\.fish|\.config/autostart/[^/]+\.desktop|"
    r"\.config/systemd/user/[^/]+\.(?:path|service|socket|timer)|Library/LaunchAgents/[^/]+\.plist)$",
    re.IGNORECASE,
)


def normalize_path_for_policy(value: str) -> str:
    """Return a stable slash-normalized path string for policy checks."""
    normalized = value.strip().strip("\"'`").strip(";,|&()[]{}").lstrip("<>").strip()
    normalized = normalized.replace("\\", "/").lower()
    return normalized.rstrip("/") if normalized not in {"", "/"} else normalized


def normalize_protected_root(value: str) -> str | None:
    """Normalize a non-root absolute directory used as a protection boundary."""
    normalized = normalize_path_for_policy(value)
    if not normalized or normalized == "/" or _WINDOWS_DRIVE_ROOT_RE.fullmatch(normalized):
        return None
    if _WINDOWS_ABSOLUTE_PATH_RE.match(normalized) or normalized.startswith("/"):
        return normalized
    return None


def is_path_within_protected_root(
    value: str,
    root: str,
    exclusions: tuple[str, ...] = (),
) -> bool:
    """Return whether one path is at or below a protected root, excluding strict subtrees."""
    normalized_value = normalize_path_for_policy(value)
    normalized_root = normalize_protected_root(root)
    if not normalized_value or normalized_root is None:
        return False
    if any(_is_same_or_child(normalized_value, exclusion) for exclusion in exclusions):
        return False
    return _is_same_or_child(normalized_value, normalized_root)


def paths_are_strictly_within_managed_session_workspace(
    paths: tuple[str, ...],
    cwd: str | None,
) -> bool:
    """Return whether all paths are strict children of a managed session cwd."""
    workspace = normalize_protected_root(cwd or "")
    if workspace is None or not is_managed_session_workspace(cwd):
        return False
    if not paths:
        return False
    prefix = f"{workspace}/"
    return all(
        (normalized := normalize_protected_root(path)) is not None
        and normalized.startswith(prefix)
        for path in paths
    )


def paths_are_at_or_below_windows_user_sessions(paths: tuple[str, ...]) -> bool:
    """Return whether every resolved path is in an Electron sessions tree."""
    if not execution_environment().product_exemptions:
        return False
    if not paths:
        return False
    return all(
        (normalized := normalize_protected_root(path)) is not None
        and not any(char in normalized[2:] for char in "$%`:?\x00")
        and not any(part in {".", ".."} for part in normalized.split("/"))
        and _WINDOWS_USER_SESSIONS_PATH_RE.fullmatch(normalized) is not None
        for path in paths
    )


def is_managed_session_workspace(cwd: str | None) -> bool:
    """Return whether cwd is an application-managed session root."""
    if not execution_environment().product_exemptions:
        return False
    workspace = normalize_protected_root(cwd or "")
    if workspace is None:
        return False
    return bool(
        _WINDOWS_ELECTRON_SESSION_WORKSPACE_RE.fullmatch(workspace)
        or _VM_SESSION_WORKSPACE_RE.fullmatch(workspace)
    )


def is_recognized_temporary_descendant(value: str) -> bool:
    """Return whether a literal path is strictly below a current temporary root."""
    raw = value.strip().strip("\"'`").replace("\\", "/")
    if (
        not raw
        or any(char in raw for char in "$%*?[]`\x00")
        or any(part in {"", ".", ".."} for part in raw.split("/")[1:])
    ):
        return False
    normalized = normalize_path_for_policy(raw)
    local_appdata = normalize_protected_root(execution_environment().local_appdata_root or "")
    windows_temp = f"{local_appdata}/temp" if local_appdata is not None else ""
    is_windows_temp = bool(windows_temp) and normalized.startswith(f"{windows_temp}/")
    return normalized.startswith(("/tmp/", "/var/tmp/")) or is_windows_temp  # noqa: S108


def is_current_windows_temporary_delete_target(value: str) -> bool:
    """Return whether a static target is strictly below the current user's Temp root."""
    raw = value.strip().strip("\"'`").replace("\\", "/")
    if (
        not raw
        or any(char in raw for char in "$%`\x00")
        or any(part in {"", ".", ".."} for part in raw.split("/")[1:])
    ):
        return False
    normalized = normalize_path_for_policy(raw)
    local_appdata = normalize_protected_root(execution_environment().local_appdata_root or "")
    windows_temp = f"{local_appdata}/temp" if local_appdata is not None else ""
    return bool(windows_temp) and normalized.startswith(f"{windows_temp}/")


def current_windows_mcp_service_root(value: str) -> str | None:
    """Return the owning current-user MCP service root for a static descendant."""
    if not execution_environment().product_exemptions:
        return None
    raw = value.strip().strip("\"'`").replace("\\", "/")
    if not raw or any(char in raw for char in "$%*?[]`\x00") or any(part in {"", ".", ".."} for part in raw.split("/")[1:]):
        return None
    normalized = normalize_protected_root(raw)
    appdata = normalize_protected_root(execution_environment().appdata_root or "")
    if normalized is None or appdata is None:
        return None
    for product in WINDOWS_PRODUCT_DATA_DIRS:
        prefix = f"{appdata}/{product}/mcp-servers/"
        if normalized.startswith(prefix):
            parts = normalized.removeprefix(prefix).split("/")
            if len(parts) > 1:
                return f"{prefix}{parts[0]}"
    return None


def is_hexagent_public_skill_descendant(value: str) -> bool:
    """Return whether a literal path is below a current-user public skill root."""
    return _is_current_hexagent_skill_descendant(value, collections=("public",))


def is_hexagent_installed_skill_script(value: str) -> bool:
    """Return whether a literal PowerShell script is below an installed skill root."""
    normalized = normalize_path_for_policy(value)
    return normalized.endswith((".ps1", ".psm1")) and _is_current_hexagent_skill_descendant(
        value,
        collections=("public", "recommended"),
    )


def _is_current_hexagent_skill_descendant(value: str, *, collections: tuple[str, ...]) -> bool:
    if not execution_environment().product_exemptions:
        return False
    raw = value.strip().strip("\"'`").replace("\\", "/")
    if (
        not raw
        or any(char in raw for char in "$%*?[]`\x00")
        or any(part in {"", ".", ".."} for part in raw.split("/")[1:])
    ):
        return False
    normalized = normalize_protected_root(raw)
    appdata = normalize_protected_root(execution_environment().appdata_root or "")
    if normalized is None or appdata is None:
        return False
    roots = tuple(
        f"{appdata}/{product}/skills/{collection}"
        for product in WINDOWS_PRODUCT_DATA_DIRS
        for collection in collections
    )
    return any(normalized.startswith(f"{root}/") for root in roots)


def contains_protected_app_dir_reference(
    value: str,
    app_dir: str,
    exclusions: tuple[str, ...] = (),
) -> bool:
    """Return whether command text explicitly references a protected app path."""
    normalized_root = normalize_protected_root(app_dir)
    if normalized_root is None:
        return False

    expanded = _APP_DIR_ENV_REFERENCE_RE.sub(normalized_root, value)
    normalized_text = normalize_path_for_policy(expanded)
    excluded_suffixes = tuple(
        exclusion[len(normalized_root) :]
        for item in exclusions
        if (exclusion := normalize_protected_root(item)) is not None
        and exclusion.startswith(f"{normalized_root}/")
    )
    exclusion_guard = "".join(
        rf"(?!{re.escape(suffix)}(?:/|$|[\s'\"`;|&)\]]))" for suffix in excluded_suffixes
    )
    pattern = re.compile(
        rf"(?<![a-z0-9_.-]){re.escape(normalized_root)}{exclusion_guard}"
        rf"(?:/|$|[\s'\"`;|&)\]])",
        re.IGNORECASE,
    )
    return pattern.search(normalized_text) is not None


def _is_same_or_child(value: str, root: str) -> bool:
    normalized_root = normalize_protected_root(root)
    return normalized_root is not None and (value == normalized_root or value.startswith(f"{normalized_root}/"))


def is_windows_host_path(value: str) -> bool:
    """Return whether the path targets a Windows host path shape."""
    return _WINDOWS_HOST_ROOT_RE.match(normalize_path_for_policy(value)) is not None


def is_macos_host_path(value: str) -> bool:
    """Return whether the path targets a macOS host path shape."""
    normalized = normalize_path_for_policy(value)
    return normalized.startswith(("/system", "/library", "/applications", "/users/", "~/library"))


def is_vm_host_mount_path(value: str) -> bool:
    """Return whether a path uses a known Pro VM host-mount shape."""
    normalized = normalize_path_for_policy(value)
    return (
        _VM_SESSION_MOUNT_RE.match(normalized) is not None
        or _VM_WINDOWS_DRIVE_MOUNT_RE.match(normalized) is not None
        or _VM_LIMA_HOST_MOUNT_RE.match(normalized) is not None
        or _WINDOWS_HOST_ROOT_RE.match(normalized) is not None
    )


def is_vm_host_mount_root(value: str) -> bool:
    """Return whether a path is an explicitly recognizable host-mount root."""
    normalized = normalize_path_for_policy(value).removesuffix("/*")
    return (
        _VM_SESSION_MOUNT_ROOT_RE.fullmatch(normalized) is not None
        or _VM_WINDOWS_DRIVE_MOUNT_ROOT_RE.fullmatch(normalized) is not None
        or _VM_LIMA_HOST_MOUNT_ROOT_RE.fullmatch(normalized) is not None
        or re.fullmatch(r"[a-z]:", normalized, re.IGNORECASE) is not None
    )


def is_vm_host_sensitive_path(value: str) -> bool:
    """Return whether a known VM host mount targets a host credential store."""
    normalized = normalize_path_for_policy(value)
    return is_vm_host_mount_path(normalized) and (
        is_host_credential_store_path(normalized) or _VM_HOST_SENSITIVE_ALIAS_RE.search(normalized) is not None
    )


def is_vm_guest_security_control_path(value: str) -> bool:
    """Return whether a path controls the managed Linux guest security boundary."""
    normalized = normalize_path_for_policy(value)
    exact = {"/etc/fstab", "/etc/ld.so.preload", "/etc/modules", "/etc/wsl.conf"}
    prefixes = (
        "/etc/modprobe.d/",
        "/etc/systemd/system/",
        "/lib/systemd/system/",
        "/proc/sys/",
        "/sys/",
        "/usr/lib/systemd/system/",
    )
    return normalized in exact or any(normalized == prefix.rstrip("/") or normalized.startswith(prefix) for prefix in prefixes)


def is_vm_control_socket_path(value: str) -> bool:
    """Return whether a path names a VM, container, or host-backed control socket."""
    normalized = normalize_path_for_policy(value)
    return _VM_CONTROL_SOCKET_RE.fullmatch(normalized) is not None or (
        is_vm_host_mount_path(normalized) and normalized.endswith(".sock")
    )


def is_host_system_mutation_path(value: str) -> bool:
    """Return whether writes/deletes to this host path should be blocked."""
    normalized = normalize_path_for_policy(value)
    return _contains_windows_system_path(normalized) or _contains_macos_system_path(normalized)


def contains_host_system_mutation_path(value: str) -> bool:
    """Return whether text contains a blocked host system path."""
    normalized = normalize_path_for_policy(value)
    return _WINDOWS_SYSTEM_PATH_RE.search(normalized) is not None or _MAC_SYSTEM_PATH_RE.search(normalized) is not None


def is_host_credential_store_path(value: str) -> bool:
    """Return whether the path targets an OS-level credential store."""
    normalized = normalize_path_for_policy(value)
    return _contains_windows_credential_path(normalized) or _MAC_CREDENTIAL_PATH_RE.search(normalized) is not None


def contains_hexagent_self_protection_path(value: str) -> bool:
    """Return whether a path targets a critical Windows product configuration file."""
    normalized = normalize_path_for_policy(value)
    return _WINDOWS_HEXAGENT_DATA_PATH_RE.fullmatch(normalized) is not None


def contains_host_credential_store_path(value: str) -> bool:
    """Return whether text contains an OS-level credential store path."""
    normalized = normalize_path_for_policy(value)
    return _WINDOWS_CREDENTIAL_PATH_RE.search(normalized) is not None or _MAC_CREDENTIAL_PATH_RE.search(normalized) is not None


def is_sensitive_path_candidate(value: str) -> bool:
    """Return whether a path-like string points at common secret material."""
    normalized = normalize_path_for_policy(value)
    if not normalized:
        return False

    parts = [part for part in normalized.split("/") if part]
    basename = parts[-1] if parts else normalized
    return (
        any(part in _SENSITIVE_SEGMENTS for part in parts)
        or is_linux_sensitive_path(normalized)
        or (".docker" in parts and basename == "config.json")
        or basename in _SENSITIVE_BASENAMES
        or _is_env_sensitive_basename(basename)
        or _is_sensitive_glob_basename(basename)
        or "private-key" in basename
        or "private_key" in basename
        or basename.endswith(_SENSITIVE_SUFFIXES)
        or is_host_credential_store_path(normalized)
        or _BROWSER_CREDENTIAL_PATH_RE.search(normalized) is not None
    )


def is_user_persistence_path(value: str) -> bool:
    """Return whether a path names an active user startup or SSH authorization file."""
    return _USER_HOME_PERSISTENCE_RE.fullmatch(normalize_path_for_policy(value)) is not None


def _is_env_sensitive_basename(basename: str) -> bool:
    if basename in _ENV_TEMPLATE_BASENAMES:
        return False
    has_glob = any(char in basename for char in "*?[")
    return basename.startswith(".env.") or (has_glob and ".env" in basename)


def _is_sensitive_glob_basename(basename: str) -> bool:
    """Detect globbed filenames that explicitly search for credential material."""
    return any(char in basename for char in "*?[") and any(term in basename for term in _SENSITIVE_GLOB_TERMS)


def is_linux_sensitive_path(value: str) -> bool:
    """Return whether a path names a critical Linux account or privilege file."""
    normalized = normalize_path_for_policy(value)
    return normalized in _LINUX_SENSITIVE_EXACT or any(
        normalized == prefix.rstrip("/") or normalized.startswith(prefix)
        for prefix in _LINUX_SENSITIVE_PREFIXES
    )


def is_linux_critical_system_path(value: str) -> bool:
    """Return whether a path is a protected Linux system mutation target."""
    normalized = normalize_path_for_policy(value)
    return normalized in _LINUX_SENSITIVE_EXACT or any(
        normalized == prefix.rstrip("/") or normalized.startswith(prefix)
        for prefix in _LINUX_CRITICAL_SYSTEM_PREFIXES
    )


def _contains_windows_system_path(normalized: str) -> bool:
    return _WINDOWS_SYSTEM_PATH_RE.search(f" {normalized}") is not None


def _contains_macos_system_path(normalized: str) -> bool:
    return _MAC_SYSTEM_PATH_RE.search(f" {normalized}") is not None


def _contains_windows_credential_path(normalized: str) -> bool:
    return _WINDOWS_CREDENTIAL_PATH_RE.search(f" {normalized}") is not None
