"""Development workflow and supply-chain shell detectors."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from ...action import ToolType
from ...baseline_rules import result_for
from ...baseline_rules.shell import ask as ask_rules
from ._patterns import _CMDPOS
from .http_request import HTTP_STATE_CHANGING_METHODS, extract_http_requests
from .profile import profile_shell_command
from ...signals import BaselineResult

if TYPE_CHECKING:
    from ...action import RuntimeAction


_GIT_DESTRUCTIVE_RE = re.compile(
    _CMDPOS + r"git\s+(?:reset\s+--hard|clean\b[^\n;|&]*(?:^|\s)-[^\s]*f[^\s]*|checkout\s+\.|restore\s+\.|branch\s+(?-i:-D)|"
    r"stash\s+(?:drop|clear)|reflog\s+(?:expire|delete)|gc\s+--prune|filter-branch|"
    r"push\b[^\n;|&]*(?:^|\s)(?:-f|--force(?:-with-lease)?)(?=$|\s))(?=$|[\s;|&\n/)])",
    re.IGNORECASE,
)


_EXTERNAL_REPOSITORY_MUTATION_RE = re.compile(
    _CMDPOS + r"(?:git\s+push\b(?![^\n;|&]*(?:--dry-run|-n)\b)|"
    r"gh\s+(?:(?:pr|issue)\s+(?:create|merge|close|comment)\b|release\s+(?:create|delete)\b)|"
    r"npm\s+publish\b|pnpm\s+publish\b|yarn\s+npm\s+publish\b|twine\s+upload\b|cargo\s+publish\b)",
    re.IGNORECASE,
)


def detect_git_destructive_operation(action: RuntimeAction) -> BaselineResult:
    """Detect Git operations that can destroy local or shared history."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    if _GIT_DESTRUCTIVE_RE.search(action.normalized_payload) or _has_additional_destructive_git_operation(action):
        return result_for(ask_rules.GIT_DESTRUCTIVE_OPERATION, action)
    return BaselineResult.no_signal()


def _has_additional_destructive_git_operation(action: RuntimeAction) -> bool:
    for invocation in profile_shell_command(action.normalized_payload).invocations:
        if invocation.canonical_name != "git" or not invocation.args:
            continue
        args = _without_git_global_options(invocation.args)
        if args and _is_destructive_git_args(args):
            return True
    return False


def _is_destructive_git_args(args: tuple[str, ...]) -> bool:
    lowered = tuple(arg.casefold() for arg in args)
    command = lowered[0]
    tail = lowered[1:]
    is_force_push = command == "push" and any(
        arg in {"-f", "--force", "--force-with-lease"} or arg.startswith("--force-with-lease=") for arg in tail
    )
    return any(
        (
            command == "reset" and any(arg in {"--hard", "--merge"} for arg in tail),
            command == "clean" and any(_has_short_flag(arg, "f") or arg == "--force" for arg in tail),
            command == "checkout" and ("--" in args or "." in tail or any(arg in {"-f", "--force"} for arg in tail)),
            command == "restore" and ("--staged" not in tail or "--worktree" in tail or "-w" in args),
            command == "switch" and ("-C" in args or "--discard-changes" in tail),
            command == "branch" and "-D" in args,
            command == "stash" and any(arg in {"drop", "clear"} for arg in tail),
            command == "reflog" and any(arg in {"expire", "delete"} for arg in tail),
            command == "gc" and any(arg == "--prune" or arg.startswith("--prune=") for arg in tail),
            command == "filter-branch",
            is_force_push,
            command == "worktree" and tail[:1] == ("remove",) and "--force" in tail[1:],
        )
    )


def _without_git_global_options(args: tuple[str, ...]) -> tuple[str, ...]:
    options_with_value = {"-c", "-C", "--exec-path", "--git-dir", "--namespace", "--work-tree"}
    index = 0
    while index < len(args):
        option, separator, _value = args[index].partition("=")
        if option not in options_with_value:
            break
        index += 1 if separator else 2
    return args[index:]


def _has_short_flag(argument: str, flag: str) -> bool:
    return argument.startswith("-") and not argument.startswith("--") and flag in argument[1:]


def detect_supply_chain_execution(action: RuntimeAction) -> BaselineResult:
    """Ask for explicit remote code sources and uninspected shell-call forms."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    for invocation in profile_shell_command(action.normalized_payload).invocations:
        # Windows tokenization can retain enclosing quotes around arguments.
        args = tuple(arg.strip("\"'") for arg in invocation.command_args)
        if reason := _supply_chain_execution_reason(invocation.canonical_name, args):
            return result_for(ask_rules.SUPPLY_CHAIN_EXECUTION, action, reason=reason)
    return BaselineResult.no_signal()


def _supply_chain_execution_reason(command: str, args: tuple[str, ...]) -> str | None:
    if command in {"npm", "pnpm", "npx", "yarn", "bun", "bunx"}:
        return _node_package_source_reason(command, args)
    if re.fullmatch(r"(?:python(?:\d+(?:\.\d+)?)?|py)", command) and args[:2] == ("-m", "pip"):
        command, args = "pip", args[2:]
    if command in {"uv", "uvx", "pipx"} or re.fullmatch(r"pip(?:\d+(?:\.\d+)?)?", command):
        detected = _python_package_source_requires_approval(command, args)
    elif command in {"deno", "cargo"}:
        detected = _runtime_package_source_requires_approval(command, args)
    else:
        detected = False
    return ask_rules.SUPPLY_CHAIN_EXECUTION.reason if detected else None


def _node_package_source_reason(command: str, args: tuple[str, ...]) -> str | None:
    """Inspect package operands, not registry settings or the executed program's arguments."""
    value_options = {
        "--cache",
        "--prefix",
        "--registry",
        "--workspace",
        "-w",
        "--userconfig",
        "--globalconfig",
        "--dir",
        "--cwd",
        "-C",
        "--filter",
        "-F",
        "--store-dir",
        "--virtual-store-dir",
        "--script-shell",
        "--proxy",
        "--https-proxy",
        "--user-agent",
    }
    subcommand = "exec" if command in {"npx", "bunx"} else ""
    package_options = {"--package", "-p"} if command in {"npx", "bun", "bunx", "yarn"} else {"--package"}
    call_options = {"--call", "-c"} if command in {"npm", "npx"} else {"--shell-mode", "-c"} if command == "pnpm" else set()
    value_options |= package_options | (call_options if command != "pnpm" else set())
    packages: list[str] = []
    operands: list[str] = []
    shell_call = False
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--":
            operands.extend(args[index + 1 :])
            break
        if not arg.startswith("-"):
            if not subcommand or (command == "yarn" and subcommand == "global"):
                subcommand = arg.casefold()
            else:
                operands.append(arg)
                # These runners stop parsing options at the executable. npm exec does not
                # stop until --, so a later --package still selects a package source.
                if command in {"npx", "bunx"} or subcommand == "dlx" or (command == "bun" and subcommand == "x"):
                    break
            index += 1
            continue
        scoped_registry = {arg.partition("=")[0]} if arg.partition("=")[0].endswith(":registry") else set()
        option, value, index = _package_option(args, index, value_options | scoped_registry)
        if option in {"--help", "-h", "--version"}:
            return None
        shell_call = shell_call or option in call_options
        if option in package_options:
            packages.append(value)

    if subcommand in {"install", "i", "add"}:
        sources = operands
    elif subcommand == "dlx" or (command in {"npm", "npx", "bun", "bunx"} and subcommand in {"exec", "x"}):
        if shell_call:
            return ask_rules.SUPPLY_CHAIN_SHELL_CALL_REASON
        sources = packages or operands[:1]
    else:
        return None
    return ask_rules.SUPPLY_CHAIN_EXECUTION.reason if any(_is_direct_node_package_source(spec) for spec in sources) else None


def _is_direct_node_package_source(spec: str) -> bool:
    spec = spec.strip("\"'")
    # A package name can prefix a URL/Git spec (including scoped names). Registry
    # aliases such as alias@npm:lodash still remain ordinary named packages.
    named_spec = re.fullmatch(r"(?:@[^/\s]+/)?[^@/\s]+@(.+)", spec)
    if named_spec and not spec.startswith("git@"):
        spec = named_spec[1]
    if _is_direct_package_source(spec) or re.match(r"(?:github:|gitlab:|bitbucket:|gist:)", spec, re.IGNORECASE):
        return True
    return not spec.startswith(("@", ".")) and re.fullmatch(r"[\w.-]+/[\w.-]+(?:#.*)?", spec) is not None


def _is_direct_package_source(spec: str) -> bool:
    """Recognize direct URLs, including Python's named requirement syntax."""
    return re.match(
        r"(?:[\w.-]+(?:\[[^\]]+\])?\s*@\s*)?(?:https?://|git(?:\+[^:]+)?://|ssh://|git@)",
        spec.strip("\"'"),
        re.IGNORECASE,
    ) is not None


def _package_option(args: tuple[str, ...], index: int, value_options: set[str]) -> tuple[str, str, int]:
    arg = args[index]
    if arg[2:] and arg[:2] in value_options:
        option, separator, value = arg[:2], "=", arg[2:].removeprefix("=")
    else:
        option, separator, value = arg.partition("=")
    index += 1
    if option in value_options and not separator and index < len(args):
        value = args[index]
        index += 1
    return option, value.strip("\"'"), index


def _package_subcommand(args: tuple[str, ...], value_options: set[str]) -> tuple[str, tuple[str, ...]]:
    """Skip global options without confusing their values with subcommands."""
    index = 0
    while index < len(args) and args[index].startswith("-"):
        if args[index] in {"--help", "-h", "--version"}:
            return "", ()
        _option, _value, index = _package_option(args, index, value_options)
    return (args[index], args[index + 1 :]) if index < len(args) else ("", ())


def _explicit_package_sources(
    args: tuple[str, ...],
    value_options: set[str],
    source_options: set[str],
    *,
    runner: bool = False,
) -> tuple[str, ...]:
    """Collect install operands or a runner target, never its application arguments."""
    sources: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--":
            sources.extend(args[index + 1 : index + 2] if runner else args[index + 1 :])
            break
        if arg.startswith("-"):
            # Metadata flags belong to the package manager only before a runner target.
            if arg in {"--help", "-h", "--version"} and arg not in value_options:
                return ()
            option, value, index = _package_option(args, index, value_options | source_options)
            if option in source_options:
                sources.append(value)
            continue
        sources.append(arg)
        if runner:
            break
        index += 1
    return tuple(sources)


def _python_package_source_requires_approval(command: str, args: tuple[str, ...]) -> bool:
    value_options = {
        "--index", "--default-index", "--index-url", "--extra-index-url", "-i", "--find-links", "-f",
        "--proxy", "--trusted-host", "--allow-insecure-host", "--cache-dir", "--cache", "--directory", "--project",
        "--config-file", "--python", "-p", "--python-version", "--python-platform", "--python-args", "--pip-args",
        "--cert", "--client-cert", "--timeout", "--retries", "--log", "--keyring-provider", "--index-strategy",
        "--target", "-t", "--prefix", "--root", "--requirement", "-r", "--constraint", "-c", "--with-requirements",
        "--config-setting", "--config-settings", "-C", "--only-binary", "--no-binary", "--exclude-newer", "--resolution",
        "--suffix", "--fetch-python", "--platform", "--implementation", "--abi", "--upgrade-package",
    }
    source_options = {"--editable", "-e"}
    if command in {"uv", "uvx"}:
        source_options |= {"--from", "--with", "--with-editable"}
    if command == "pipx":
        source_options |= {"--spec", "--preinstall"}
    if command == "uvx":
        subcommand = "run"
    else:
        subcommand, args = _package_subcommand(args, value_options)
        if command == "uv" and subcommand in {"pip", "tool"}:
            subcommand, args = _package_subcommand(args, value_options)
    if subcommand not in {"install", "run", "add"}:
        return False
    sources = _explicit_package_sources(args, value_options, source_options, runner=subcommand == "run")
    return any(_is_direct_package_source(spec) for spec in sources)


def _runtime_package_source_requires_approval(command: str, args: tuple[str, ...]) -> bool:
    if command == "cargo":
        value_options = {"--config", "--color", "-Z", "--root", "--registry", "--index", "--version", "--path", "--target", "--target-dir"}
        subcommand, args = _package_subcommand(args, value_options)
        if subcommand != "install":
            return False
        sources = _explicit_package_sources(args, value_options, {"--git"})
    else:
        # Optional-value flags such as --lock and --env-file require '='; they
        # must not consume the following script target when used as bare flags.
        value_options = {"--config", "-c", "--import-map", "--cert", "--location", "--v8-flags", "--seed", "--log-level"}
        subcommand, args = _package_subcommand(args, value_options)
        if subcommand != "run":
            return False
        sources = _explicit_package_sources(args, value_options, set(), runner=True)
    return any(_is_direct_package_source(spec) for spec in sources)


def detect_external_repository_mutation(action: RuntimeAction) -> BaselineResult:
    """Detect commands that mutate shared source or package registries."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    if (
        _EXTERNAL_REPOSITORY_MUTATION_RE.search(action.normalized_payload)
        or _has_git_push_mutation(action)
        or any(
            _is_external_repository_mutation(invocation.canonical_name, invocation.args)
            for invocation in profile_shell_command(action.normalized_payload).invocations
        )
    ):
        return result_for(ask_rules.EXTERNAL_REPOSITORY_MUTATION, action)
    return BaselineResult.no_signal()


def _has_git_push_mutation(action: RuntimeAction) -> bool:
    for invocation in profile_shell_command(action.normalized_payload).invocations:
        if invocation.canonical_name != "git":
            continue
        args = _without_git_global_options(invocation.args)
        if not args or args[0].casefold() != "push":
            continue
        lowered = tuple(arg.casefold() for arg in args[1:])
        if not any(arg in {"--dry-run", "-n"} for arg in lowered):
            return True
    return False


def _is_external_repository_mutation(command: str, args: tuple[str, ...]) -> bool:
    if _mutates_repository_api(command, args):
        return True
    lowered = tuple(arg.casefold() for arg in args)
    if command in {"docker", "nerdctl", "podman"}:
        return _container_subcommand(lowered) == "push"
    if command == "gh":
        return lowered[:2] in {
            ("release", "edit"),
            ("release", "upload"),
            ("repo", "archive"),
            ("repo", "delete"),
            ("repo", "edit"),
            ("secret", "delete"),
            ("secret", "set"),
            ("variable", "delete"),
            ("variable", "set"),
            ("workflow", "disable"),
            ("workflow", "enable"),
            ("workflow", "run"),
        } or (
            lowered[:1] == ("api",) and _gh_api_mutates(lowered[1:])
        )
    if command == "glab":
        return lowered[:2] in {
            ("issue", "close"),
            ("issue", "create"),
            ("mr", "close"),
            ("mr", "create"),
            ("mr", "merge"),
            ("release", "create"),
            ("release", "delete"),
        }
    if command == "npm":
        subcommand, _tail = _npm_subcommand(lowered)
        return subcommand in {"deprecate", "publish", "unpublish"}
    return (command == "poetry" and lowered[:1] == ("publish",)) or (
        command == "flit" and lowered[:1] == ("publish",)
    )


def _mutates_repository_api(command: str, args: tuple[str, ...]) -> bool:
    """Detect state-changing GitHub and GitLab REST requests."""
    for method, url in extract_http_requests(command, args):
        if method not in HTTP_STATE_CHANGING_METHODS:
            continue
        try:
            parsed = urlsplit(url)
        except ValueError:
            continue
        host = (parsed.hostname or "").casefold().rstrip(".")
        path = parsed.path.casefold().rstrip("/")
        if host in {"api.github.com", "uploads.github.com"} and path.startswith("/repos/"):
            return True
        if host == "api.github.com" and path == "/graphql":
            return re.search(r"\bmutation\b", " ".join(args), re.IGNORECASE) is not None
        if host == "gitlab.com" and path.startswith("/api/v4/projects/"):
            return True
    return False


def _container_subcommand(args: tuple[str, ...]) -> str:
    options_with_value = {"--connection", "--context", "--host", "--namespace"}
    flags = {"--debug", "--tls", "--tlsverify", "-d"}
    index = 0
    while index < len(args):
        option, separator, _value = args[index].partition("=")
        if option in flags:
            index += 1
            continue
        if option not in options_with_value:
            break
        index += 1 if separator else 2
    return args[index] if index < len(args) else ""


def _npm_subcommand(args: tuple[str, ...]) -> tuple[str, tuple[str, ...]]:
    options_with_value = {"--cache", "--prefix", "--registry", "--workspace", "-w"}
    index = 0
    while index < len(args):
        option, separator, _value = args[index].partition("=")
        if not option.startswith("-"):
            return option, args[index + 1 :]
        index += 2 if option in options_with_value and not separator else 1
    return "", ()


def _gh_api_mutates(args: tuple[str, ...]) -> bool:
    for index, arg in enumerate(args):
        option, separator, value = arg.partition("=")
        if option not in {"--method", "-x"}:
            continue
        method = value if separator else (args[index + 1] if index + 1 < len(args) else "")
        return method in {"delete", "patch", "post", "put"}
    return any(
        arg in {"--field", "--input", "--raw-field", "-f", "-F"}
        or arg.startswith(("--field=", "--input=", "--raw-field=", "-f=", "-F="))
        for arg in args
    )
