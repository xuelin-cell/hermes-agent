"""Container, orchestration, and cloud control-plane shell detectors."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING
from urllib.parse import unquote

from ...action import ToolType
from ...baseline_rules import result_for
from ...baseline_rules.shell import ask as ask_rules
from ...baseline_rules.shell import terminal as terminal_rules
from ._patterns import _CMDPOS
from .profile import profile_shell_command
from ...signals import BaselineResult

if TYPE_CHECKING:
    from ...action import RuntimeAction


_GLOBAL_OPTIONS_WITH_VALUE: dict[str, frozenset[str]] = {
    "docker": frozenset({"--config", "--context", "--host", "-h", "--log-level"}),
    "kubectl": frozenset({"--cluster", "--context", "--kubeconfig", "--namespace", "-n", "--server", "--user"}),
    "aws": frozenset({"--endpoint-url", "--output", "--profile", "--region"}),
}
_GLOBAL_FLAGS: dict[str, frozenset[str]] = {
    "docker": frozenset({"--debug", "-d", "--tls", "--tlsverify"}),
    "kubectl": frozenset({"--disable-compression", "--insecure-skip-tls-verify"}),
    "aws": frozenset({"--debug", "--no-cli-pager", "--no-sign-request"}),
}
_ASK_GLOBAL_OPTIONS_WITH_VALUE: dict[str, frozenset[str]] = {
    "az": frozenset({"--subscription", "--tenant"}),
    "firebase": frozenset({"--config", "--project", "--token"}),
    "fly": frozenset({"--access-token", "--app", "--config", "--org"}),
    "flyctl": frozenset({"--access-token", "--app", "--config", "--org"}),
    "gcloud": frozenset({"--account", "--configuration", "--project", "--region"}),
    "netlify": frozenset({"--filter"}),
    "nerdctl": frozenset({"--address", "--namespace", "-a", "-n"}),
    "podman": frozenset({"--connection", "--context", "--log-level", "--url"}),
    "railway": frozenset({"--environment", "--project", "--service"}),
    "vercel": frozenset({"--cwd", "--local-config", "--scope", "--token"}),
    "wrangler": frozenset({"--config", "--cwd", "--env", "-c", "-e"}),
}
_ASK_GLOBAL_FLAGS: dict[str, frozenset[str]] = {
    "az": frozenset({"--debug", "--only-show-errors", "--verbose"}),
    "firebase": frozenset({"--debug", "--non-interactive"}),
    "fly": frozenset({"--verbose"}),
    "flyctl": frozenset({"--verbose"}),
    "gcloud": frozenset({"--quiet"}),
    "netlify": frozenset({"--telemetry-disable"}),
    "nerdctl": frozenset({"--debug"}),
    "podman": frozenset(),
    "railway": frozenset(),
    "vercel": frozenset({"--debug"}),
    "wrangler": frozenset(),
}


_CONTROL_PLANE_DESTRUCTIVE_RE = re.compile(
    _CMDPOS + r"(?:kubectl\s+delete\b|(?:terraform|tofu)\s+(?:destroy\b|apply\b[^\n;]*-destroy\b))",
    re.IGNORECASE,
)


_CONTAINER_ESCAPE_RE = re.compile(
    _CMDPOS + r"docker\s+run\b(?=[^\n;]*--privileged)(?=[^\n;]*(?:-v\s+/:/host|--volume\s+/:/host|--pid=host))",
    re.IGNORECASE,
)


_HOST_ROOT_MOUNT_DESTRUCTIVE_CONTAINER_RE = re.compile(
    _CMDPOS + r"docker\s+run\b"
    r"(?=[^\n;]*(?:(?:-v|--volume)(?:=|\s+)/:/(?:host|mnt|root|hostfs)\b|"
    r"--mount\b[^\n;]*(?:source|src)=/(?:,|\s)[^\n;]*(?:target|dst|destination)=/(?:host|mnt|root|hostfs)\b))"
    r"(?=[^\n;]*(?:\brm\s+(?:-[^\s]*r[^\s]*\s+)+/(?:host|mnt|root|hostfs)(?:\b|/|\*)|"
    r"\bshred\b[^\n;]*/(?:host|mnt|root|hostfs)\b|"
    r"\bchmod\s+-R\s+(?:000|777)\s+/(?:host|mnt|root|hostfs)\b))",
    re.IGNORECASE,
)


_K8S_MASS_DELETE_RE = re.compile(
    _CMDPOS + r"kubectl\s+delete\b(?=[^\n;]*(?:--all|--all-namespaces|"
    r"\b(?:namespace|namespaces|ns|persistentvolume|persistentvolumes|pv|pvc)\b))",
    re.IGNORECASE,
)


_DOCKER_DESTRUCTIVE_RE = re.compile(
    _CMDPOS + r"docker\s+(?:rm\s+-f\s+\$\(docker\s+ps\s+-aq\)|"
    r"rmi\s+-f\s+\$\(docker\s+images\s+-aq\)|"
    r"volume\s+rm\s+\$\(docker\s+volume\s+ls\s+-q\)|"
    r"volume\s+(?:prune\b|rm\b)|compose\s+down\b[^\n;]*(?:-v|--volumes)\b|"
    r"system\s+prune\b[^\n;]*--volumes)",
    re.IGNORECASE,
)


_DOCKER_DESTRUCTIVE_TERMINAL_RE = re.compile(
    _CMDPOS + r"docker\s+volume\s+rm\s+\$\(docker\s+volume\s+ls\s+-q\)",
    re.IGNORECASE,
)


_CLOUD_DESTRUCTIVE_RE = re.compile(
    _CMDPOS + r"(?:aws\s+(?:s3\s+rm\b[^\n;]*--recursive|ec2\s+terminate-instances\b|iam\s+delete-role\b|"
    r"rds\s+delete-db-instance\b|cloudformation\s+delete-stack\b|eks\s+delete-cluster\b)|"
    r"gcloud\s+(?:projects\s+delete|compute\s+instances\s+delete)\b|"
    r"az\s+(?:group|vm)\s+delete\b|"
    r"aliyun\s+(?:ecs\s+DeleteInstance|oss\s+rm\b[^\n;]*-r\b)|"
    r"tccli\s+(?:cvm\s+TerminateInstances|cam\s+DeleteRole)\b)",
    re.IGNORECASE,
)


_CLOUD_DESTRUCTIVE_TERMINAL_RE = re.compile(
    _CMDPOS + r"(?:aws\s+iam\s+delete-role\b|gcloud\s+projects\s+delete\b)",
    re.IGNORECASE,
)


_CLOUD_API_RESOURCE_RE = re.compile(r"/(?:api/)?(?:iam/)?(?:roles?|projects?)(?:[/?\s]|$)", re.IGNORECASE)
_CLOUD_API_DELETE_ENDPOINT_RE = re.compile(r"/(?:api/)?(?:iam/)?delete-(?:role|project)(?:[/?\s]|$)", re.IGNORECASE)
_CLOUD_API_TARGET_FIELD_RE = re.compile(r"\b(?:project[_-]?id|project[_-]?name|role[_-]?name)\b", re.IGNORECASE)


def detect_container_escape(action: RuntimeAction) -> BaselineResult:
    """Deny Docker runs that combine privilege with host escape primitives."""
    if _matches_control_plane_pattern(_CONTAINER_ESCAPE_RE, action):
        return result_for(terminal_rules.CONTAINER_ESCAPE, action, rule_content="container_escape")
    return BaselineResult.no_signal()


def detect_host_root_mount_destructive_container(action: RuntimeAction) -> BaselineResult:
    """Deny destructive writes through a container bind-mounted host root."""
    if _matches_control_plane_pattern(_HOST_ROOT_MOUNT_DESTRUCTIVE_CONTAINER_RE, action):
        return result_for(
            terminal_rules.HOST_ROOT_MOUNT_DESTRUCTIVE_CONTAINER,
            action,
            rule_content="host_root_mount_destructive_container",
        )
    return BaselineResult.no_signal()


def detect_k8s_mass_delete(action: RuntimeAction) -> BaselineResult:
    """Deny broad Kubernetes delete operations."""
    if _matches_control_plane_pattern(_K8S_MASS_DELETE_RE, action):
        return result_for(terminal_rules.K8S_MASS_DELETE, action, rule_content="k8s_mass_delete")
    return BaselineResult.no_signal()


def detect_docker_destructive_terminal(action: RuntimeAction) -> BaselineResult:
    """Deny broad Docker data and image deletion operations."""
    if _is_docker_volume_rm_all(action) or _matches_control_plane_pattern(_DOCKER_DESTRUCTIVE_TERMINAL_RE, action):
        return result_for(terminal_rules.DOCKER_DESTRUCTIVE_TERMINAL, action, rule_content="docker_destructive_operation")
    return BaselineResult.no_signal()


def detect_cloud_destructive_terminal(action: RuntimeAction) -> BaselineResult:
    """Deny cloud control-plane deletion operations."""
    if _matches_control_plane_pattern(_CLOUD_DESTRUCTIVE_TERMINAL_RE, action) or _is_curl_cloud_control_plane_delete(action):
        return result_for(terminal_rules.CLOUD_DESTRUCTIVE_TERMINAL, action, rule_content="cloud_destructive_operation")
    return BaselineResult.no_signal()


def detect_docker_destructive_operation(action: RuntimeAction) -> BaselineResult:
    """Detect explicit container-volume deletion and prune operations."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    if _matches_control_plane_pattern(_DOCKER_DESTRUCTIVE_RE, action) or any(
        _deletes_container_volumes(invocation.canonical_name, invocation.args)
        for invocation in profile_shell_command(action.normalized_payload).invocations
    ):
        return result_for(ask_rules.DOCKER_DESTRUCTIVE_OPERATION, action)
    return BaselineResult.no_signal()


def detect_cloud_destructive_operation(action: RuntimeAction) -> BaselineResult:
    """Detect cloud control-plane destructive operations."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    if _matches_control_plane_pattern(_CLOUD_DESTRUCTIVE_RE, action) or any(
        _is_destructive_cloud_operation(invocation.canonical_name, invocation.args)
        for invocation in profile_shell_command(action.normalized_payload).invocations
    ):
        return result_for(ask_rules.CLOUD_DESTRUCTIVE_OPERATION, action)
    return BaselineResult.no_signal()


def detect_control_plane_destructive_operation(action: RuntimeAction) -> BaselineResult:
    """Detect destructive container, Kubernetes, and infrastructure actions."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    if _matches_control_plane_pattern(_CONTROL_PLANE_DESTRUCTIVE_RE, action) or any(
        _is_destructive_control_plane_operation(invocation.canonical_name, invocation.args)
        for invocation in profile_shell_command(action.normalized_payload).invocations
    ):
        return result_for(ask_rules.CONTROL_PLANE_DESTRUCTIVE_OPERATION, action)
    return BaselineResult.no_signal()


def detect_external_control_plane_mutation(action: RuntimeAction) -> BaselineResult:
    """Detect explicit non-read-only mutations of external control planes."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    for invocation in profile_shell_command(action.normalized_payload).invocations:
        if _mutates_external_control_plane(invocation.canonical_name, invocation.args):
            return result_for(ask_rules.EXTERNAL_CONTROL_PLANE_MUTATION, action)
    return BaselineResult.no_signal()


def _mutates_external_control_plane(command: str, raw_args: tuple[str, ...]) -> bool:
    if _deploys_external_service(command, raw_args):
        return True
    if command == "kubectl":
        args = tuple(arg.casefold() for arg in _without_leading_global_options("kubectl", raw_args))
        return not _has_dry_run(args) and (
            (
                bool(args)
                and args[0]
                in {
                    "annotate",
                    "apply",
                    "autoscale",
                    "cordon",
                    "create",
                    "edit",
                    "expose",
                    "label",
                    "patch",
                    "replace",
                    "scale",
                    "taint",
                    "uncordon",
                }
            )
            or args[:2] == ("rollout", "restart")
            or args[:2] == ("rollout", "undo")
            or (args[:1] == ("certificate",) and args[1:2] in {("approve",), ("deny",)})
            or (args[:1] == ("set",) and args[1:2] in {("env",), ("image",), ("resources",), ("selector",), ("serviceaccount",)})
        )
    if command in {"terraform", "tofu"}:
        args = tuple(arg.casefold() for arg in _without_infrastructure_global_options(raw_args))
        return args[:1] in {("apply",), ("force-unlock",), ("import",), ("taint",), ("untaint",)} or args[:2] in {
            ("state", "mv"),
            ("state", "rm"),
            ("state", "replace-provider"),
            ("state", "push"),
            ("workspace", "delete"),
        }
    if command == "pulumi":
        args = tuple(arg.casefold() for arg in raw_args)
        return args[:1] in {("destroy",), ("up",)} or args[:2] in {
            ("config", "rm"),
            ("config", "set"),
            ("stack", "import"),
            ("stack", "rename"),
            ("stack", "rm"),
            ("state", "delete"),
            ("state", "move"),
            ("state", "repair"),
            ("state", "unprotect"),
        } or (args[:1] == ("refresh",) and "--yes" in args[1:])
    if command == "helm":
        args = tuple(arg.casefold() for arg in raw_args)
        return args[:1] in {("install",), ("upgrade",), ("uninstall",), ("rollback",)} and not _has_dry_run(args)
    args = tuple(arg.casefold() for arg in raw_args)
    return command == "ansible-playbook" and "--check" not in args and "-C" not in raw_args


def _deploys_external_service(command: str, raw_args: tuple[str, ...]) -> bool:
    """Recognize explicit deployment commands while excluding local/read-only modes."""
    if command not in {"firebase", "fly", "flyctl", "gcloud", "netlify", "railway", "vercel", "wrangler"}:
        return False
    lowered = tuple(arg.casefold() for arg in raw_args)
    if any(arg in {"-?", "-h", "--help", "--version", "version"} for arg in lowered):
        return False
    if "--dry-run" in lowered:
        return False
    args = tuple(arg.casefold() for arg in _without_ask_global_options(command, raw_args))
    if command == "vercel":
        detected = args[:1] == ("deploy",) or ("--prod" in args and not any(arg in {"dev", "inspect", "list"} for arg in args))
    elif command in {"fly", "flyctl"}:
        detected = args[:1] == ("deploy",)
    elif command == "gcloud":
        detected = args[:2] in {("app", "deploy"), ("functions", "deploy"), ("run", "deploy")}
    else:
        deployment_subcommands = {
            "firebase": frozenset({"deploy"}),
            "netlify": frozenset({"deploy"}),
            "railway": frozenset({"up"}),
            "wrangler": frozenset({"deploy", "publish"}),
        }
        detected = bool(args) and args[0] in deployment_subcommands.get(command, frozenset())
    return detected


def detect_container_privileged_operation(action: RuntimeAction) -> BaselineResult:
    """Detect containers that receive broad host privileges or mounts."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    if any(
        _starts_privileged_container(invocation.canonical_name, invocation.args)
        for invocation in profile_shell_command(action.normalized_payload).invocations
    ):
        return result_for(ask_rules.CONTAINER_PRIVILEGED_OPERATION, action)
    return BaselineResult.no_signal()


def _matches_control_plane_pattern(pattern: re.Pattern[str], action: RuntimeAction) -> bool:
    """Match raw commands plus a view with known CLI-global options removed."""
    return any(pattern.search(command) for command in _control_plane_command_views(action))


def _is_curl_cloud_control_plane_delete(action: RuntimeAction) -> bool:
    for invocation in profile_shell_command(action.normalized_payload).invocations:
        if invocation.canonical_name != "curl":
            continue
        arguments = tuple(arg.strip().strip("\"'`") for arg in invocation.args)
        argument_text = unquote(" ".join(arguments))
        if _curl_uses_method(arguments, "delete") and _CLOUD_API_RESOURCE_RE.search(argument_text):
            return True
        if (
            _curl_uses_method(arguments, "post")
            and _CLOUD_API_DELETE_ENDPOINT_RE.search(argument_text)
            and _CLOUD_API_TARGET_FIELD_RE.search(argument_text)
        ):
            return True
    return False


def _curl_uses_method(arguments: tuple[str, ...], method: str) -> bool:
    expected = method.casefold()
    for index, argument in enumerate(arguments):
        option = argument.casefold()
        if option in {"-x", "--request"}:
            return index + 1 < len(arguments) and arguments[index + 1].casefold() == expected
        if option.startswith("--request="):
            return option.partition("=")[2] == expected
        if option.startswith("-x") and len(option) > len("-x"):
            return option.removeprefix("-x") == expected
    return False


def _control_plane_command_views(action: RuntimeAction) -> tuple[str, ...]:
    """Return command views that expose subcommands after explicit global options.

    Docker, kubectl, and AWS accept options such as ``--context`` or
    ``--profile`` between the executable and subcommand.  Only documented,
    explicitly listed global options are skipped here; arbitrary arguments are
    kept so malformed or unrelated commands are not reinterpreted.
    """
    views = [action.normalized_payload]
    for invocation in profile_shell_command(action.normalized_payload).invocations:
        command = invocation.canonical_name
        if command not in _GLOBAL_OPTIONS_WITH_VALUE:
            continue
        args = _without_leading_global_options(command, invocation.args)
        if args != invocation.args:
            views.append(" ".join((command, *args)))
    return tuple(dict.fromkeys(views))


def _without_leading_global_options(command: str, args: tuple[str, ...]) -> tuple[str, ...]:
    with_value = _GLOBAL_OPTIONS_WITH_VALUE[command]
    flags = _GLOBAL_FLAGS[command]
    index = 0
    while index < len(args):
        option, separator, _value = args[index].casefold().partition("=")
        if option in flags and not separator:
            index += 1
            continue
        if option not in with_value:
            break
        if separator:
            index += 1
            continue
        if index + 1 >= len(args):
            break
        index += 2
    return args[index:]


def _without_ask_global_options(command: str, args: tuple[str, ...]) -> tuple[str, ...]:
    with_value = _ASK_GLOBAL_OPTIONS_WITH_VALUE.get(command, frozenset())
    flags = _ASK_GLOBAL_FLAGS.get(command, frozenset())
    index = 0
    while index < len(args):
        option, separator, _value = args[index].casefold().partition("=")
        if option in flags or any(option.startswith(f"{flag}=") for flag in flags):
            index += 1
            continue
        if option not in with_value:
            break
        index += 1 if separator else 2
    return args[index:]


def _has_dry_run(args: tuple[str, ...]) -> bool:
    return any(arg == "--dry-run" or arg.startswith("--dry-run=") for arg in args)


def _is_destructive_control_plane_operation(command: str, raw_args: tuple[str, ...]) -> bool:
    if command == "kubectl":
        args = tuple(arg.casefold() for arg in _without_leading_global_options("kubectl", raw_args))
        return args[:1] in {("delete",), ("drain",)}
    if command in {"terraform", "tofu", "terragrunt"}:
        args = tuple(arg.casefold() for arg in _without_infrastructure_global_options(raw_args))
        return args[:1] == ("destroy",) or (
            args[:1] == ("apply",) and any(arg == "-destroy" or arg.startswith("-destroy=") for arg in args[1:])
        )
    return False


def _is_destructive_cloud_operation(command: str, raw_args: tuple[str, ...]) -> bool:
    if command in _ASK_GLOBAL_OPTIONS_WITH_VALUE:
        raw_args = _without_ask_global_options(command, raw_args)
    args = tuple(arg.casefold() for arg in raw_args)
    if command == "aws":
        args = tuple(arg.casefold() for arg in _without_leading_global_options("aws", raw_args))
        return args[:2] == ("s3", "rb") or args[:3] == ("s3", "rm", "--recursive") or (
            args[:2]
            in {
                ("cloudformation", "delete-stack"),
                ("ec2", "terminate-instances"),
                ("eks", "delete-cluster"),
                ("iam", "delete-role"),
                ("rds", "delete-db-instance"),
            }
        ) or (args[:2] == ("s3", "rm") and "--recursive" in args[2:])
    if command == "gcloud":
        return args[:2] == ("projects", "delete") or args[:3] == ("compute", "instances", "delete")
    if command == "az":
        return args[:2] in {("group", "delete"), ("vm", "delete")}
    return False


def _without_infrastructure_global_options(args: tuple[str, ...]) -> tuple[str, ...]:
    index = 0
    while index < len(args):
        option, separator, _value = args[index].casefold().partition("=")
        if option not in {"-chdir", "--working-dir"}:
            break
        index += 1 if separator else 2
    return args[index:]


def _starts_privileged_container(command: str, raw_args: tuple[str, ...]) -> bool:
    if command not in {"docker", "nerdctl", "podman"}:
        return False
    args = _without_leading_global_options("docker", raw_args) if command == "docker" else _without_ask_global_options(command, raw_args)
    if not args or args[0].casefold() not in {"create", "run"}:
        return False
    options = args[1:]
    return any(
        (
            _has_enabled_option(options, "--privileged"),
            _has_option_value(options, {"--cap-add"}, {"all", "sys_admin"}),
            _has_option(options, {"--device"}),
            _has_option_value(options, {"--ipc", "--pid", "--userns"}, {"host"}),
            _mounts_host_root(options),
        )
    )


def _has_enabled_option(args: tuple[str, ...], option_name: str) -> bool:
    lowered = tuple(arg.casefold() for arg in args)
    return option_name in lowered or f"{option_name}=true" in lowered


def _has_option(args: tuple[str, ...], option_names: set[str]) -> bool:
    for arg in args:
        option = arg.casefold().partition("=")[0]
        if option in option_names:
            return True
    return False


def _has_option_value(args: tuple[str, ...], option_names: set[str], expected_values: set[str]) -> bool:
    for index, arg in enumerate(args):
        option, separator, value = arg.casefold().partition("=")
        if option not in option_names:
            continue
        candidate = value if separator else (args[index + 1].casefold() if index + 1 < len(args) else "")
        if any(value_part.strip() in expected_values for value_part in candidate.split(",")):
            return True
    return False


def _mounts_host_root(args: tuple[str, ...]) -> bool:
    for index, arg in enumerate(args):
        option, separator, inline = arg.partition("=")
        lowered_option = option.casefold()
        if lowered_option in {"-v", "--volume"}:
            value = inline if separator else (args[index + 1] if index + 1 < len(args) else "")
            if _is_host_root_volume(value):
                return True
        if lowered_option == "--mount":
            value = inline if separator else (args[index + 1] if index + 1 < len(args) else "")
            fields: dict[str, str] = {}
            for field in value.split(","):
                key, field_separator, field_value = field.partition("=")
                if field_separator:
                    fields[key.casefold()] = field_value
            if _is_host_root_source(fields.get("source", fields.get("src", ""))):
                return True
    return False


def _is_host_root_volume(value: str) -> bool:
    normalized = value.strip().strip("\"'`")
    return normalized.startswith("/:") or re.match(r"^[A-Za-z]:[\\/]+:", normalized) is not None


def _is_host_root_source(value: str) -> bool:
    normalized = value.strip().strip("\"'`")
    return normalized == "/" or re.fullmatch(r"[A-Za-z]:[\\/]?", normalized) is not None


def _deletes_container_volumes(command: str, raw_args: tuple[str, ...]) -> bool:
    if command not in {"docker", "docker-compose", "nerdctl", "podman"}:
        return False
    args = _without_leading_global_options("docker", raw_args) if command == "docker" else _without_ask_global_options(command, raw_args)
    lowered = tuple(arg.casefold() for arg in args)
    if command == "docker-compose":
        return lowered[:1] in {("down",), ("rm",)} and any(_has_short_flag(arg, "v") or arg == "--volumes" for arg in lowered[1:])
    return (
        lowered[:2] in {("volume", "prune"), ("volume", "rm")}
        or (
            lowered[:2] in {("compose", "down"), ("compose", "rm")}
            and any(_has_short_flag(arg, "v") or arg == "--volumes" for arg in lowered[2:])
        )
        or (lowered[:2] == ("system", "prune") and "--volumes" in lowered[2:])
    )


def _has_short_flag(argument: str, flag: str) -> bool:
    return argument.startswith("-") and not argument.startswith("--") and flag in argument[1:]


def _is_docker_volume_rm_all(action: RuntimeAction) -> bool:
    """Recognize bulk volume removal when both Docker calls use globals."""
    removes_enumerated_volumes = False
    enumerates_volumes = False
    for invocation in profile_shell_command(action.normalized_payload).invocations:
        if invocation.canonical_name != "docker":
            continue
        args = tuple(arg.casefold() for arg in _without_leading_global_options("docker", invocation.args))
        removes_enumerated_volumes |= args[:2] == ("volume", "rm") and any(arg.startswith("$(") for arg in args[2:3])
        enumerates_volumes |= args[:2] == ("volume", "ls") and "-q" in args[2:]
    return removes_enumerated_volumes and enumerates_volumes
