"""Host execution descriptions shared by tools and final policy callbacks."""

from pathlib import Path
import os
import stat

from hermes_cli.plugins_execution import (
    ExecutionCapabilities, FileExecutionTarget, PreparedToolExecution, current_call,
    enforce_tool_execution, execution_policy_available, thaw, tool_execution_scope,
)


def _read_local_script(path, limit):
    if not 0 < limit <= 1024 * 1024 + 1:
        raise ValueError("Invalid script inspection limit")
    target = Path(path)
    try:
        mode = target.stat().st_mode
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(mode):
        raise ValueError("Script inspection requires a regular file")
    with target.open("rb") as stream:
        return stream.read(limit)


def _local_capabilities():
    return ExecutionCapabilities(
        read_script=_read_local_script,
        exists=lambda path: Path(path).exists() or Path(path).is_symlink(),
        is_directory=lambda path: Path(path).is_dir(),
        resolve_path=_resolve_local_policy_path,
    )


def _resolve_local_policy_path(path, cwd):
    from tools.environments.local import _msys_to_windows_path
    error = check_prepared_paths([path])
    if error:
        raise ValueError(error)
    target = Path(_msys_to_windows_path(path))
    if not target.is_absolute():
        # Git Bash virtual roots cannot be guessed from a Windows cwd.
        if target.root or target.drive:
            if path == "/dev/null":
                return path
            raise ValueError("Unresolved shell-root or drive-relative path")
        if not cwd or any(char in path for char in "$%*?[]~"):
            return path
        target = Path(cwd) / target
    return str(target.resolve())


def _execution_backend(task_id):
    from tools.terminal_tool import _get_env_config, resolve_task_overrides
    return str(resolve_task_overrides(task_id).get("env_type") or _get_env_config()["env_type"])


def _description(tool_name, arguments, *, task_id="default", session_id="", targets=(),
                 backend=None, cwd=None, workspace_root=None, shell=None, environment=None):
    from tools.file_tools_paths import _resolve_base_dir
    from hermes_platform.host.facts import os_family
    from hermes_constants import hermes_home_key
    from tools.environments.local import hermes_subprocess_env
    call = current_call(tool_name)
    ids = call[2] if call else {}
    arguments = {**(thaw(call[1]) if call else {}), **arguments}
    task_id = str(task_id or ids.get("task_id") or "default")
    backend = backend or _execution_backend(task_id)
    if workspace_root is None:
        from tools.terminal_tool import _get_env_config, resolve_task_overrides
        workspace_root = resolve_task_overrides(task_id).get("cwd") or _get_env_config()["cwd"]
        if backend == "local":
            from tools.environments.local import _msys_to_windows_path
            workspace_root = str(Path(_msys_to_windows_path(workspace_root)).expanduser().resolve())
    if cwd is None and backend == "local":
        cwd = str(_resolve_base_dir(task_id))
    # Non-secret path facts only, using the same profile-scoped child environment.
    child_env = (hermes_subprocess_env() | (environment or {})) if backend == "local" else {}
    path_keys = {"HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"}
    environment = {key.upper(): value for key, value in child_env.items() if key.upper() in path_keys}
    return PreparedToolExecution(
        tool_name=tool_name, arguments=arguments, targets=targets, backend=backend,
        operating_system=os_family() if backend == "local" else None,
        shell=shell, cwd=cwd, workspace_root=workspace_root,
        task_id=task_id, session_id=session_id or ids.get("session_id", ""),
        tool_call_id=ids.get("tool_call_id", ""), turn_id=ids.get("turn_id", ""),
        profile_scope=hermes_home_key(),
        environment=environment,
        capabilities=_local_capabilities() if backend == "local" else ExecutionCapabilities(),
    )


def check_prepared_paths(paths):
    """Reject unresolvable host namespaces before any network dereference."""
    if not execution_policy_available():
        return None
    from agent.file_safety import get_nt_namespace_error
    for path in paths:
        if not isinstance(path, str) or not path.strip():
            return "BLOCKED: execution target is missing"
        if path.startswith(("\\\\", "//")) or get_nt_namespace_error(path):
            return "BLOCKED: this execution description does not support network/device paths"
    return None


def authorize_file(tool_name, arguments, targets, *, task_id="default", session_id=""):
    if not execution_policy_available():
        return None
    if any(not target.path for target in targets):
        return "BLOCKED: an execution target could not be resolved"
    return enforce_tool_execution(_description(
        tool_name, arguments, task_id=task_id, session_id=session_id, targets=tuple(targets)))


def authorize_arguments(tool_name, arguments, *, task_id=None, session_id=""):
    """Gate normalized non-filesystem inputs before a provider or remote call."""
    if not execution_policy_available():
        return None
    return enforce_tool_execution(_description(tool_name, arguments, task_id=task_id, session_id=session_id))


def resolve_execution_target(path, task_id, *, entry=False):
    if not path or not execution_policy_available():
        return path
    if _execution_backend(task_id) != "local":
        return path
    target = Path(path)
    return str(target.parent.resolve() / target.name if entry else target.resolve())


def patch_execution_targets(mode, path, new_string, patch, resolved, entries, task_id="default"):
    if mode == "replace":
        return (FileExecutionTarget("write", resolved.get(path) or "", path or "", content=new_string or ""),)
    if mode != "patch" or not patch:
        raise ValueError("Invalid patch mode or missing patch")
    from tools.patch_parser import OperationType, parse_v4a_patch
    operations, error = parse_v4a_patch(patch)
    if error or not operations:
        raise ValueError("Patch requires valid operations")
    from tools.file_tools_paths import _resolve_base_dir
    base = str(_resolve_base_dir(task_id))
    def lexical(raw):
        from tools.environments.local import _msys_to_windows_path
        return os.path.normcase(os.path.normpath(os.path.join(base, _msys_to_windows_path(raw))))
    for index, operation in enumerate(operations):
        if operation.operation is not OperationType.MOVE:
            continue
        source = Path(entries.get(operation.file_path) or "")
        try:
            metadata = source.lstat()
        except FileNotFoundError:
            continue
        # lstat's reparse attribute also works on Python 3.11 (no is_junction).
        if not (stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
            continue
        affected = [lexical(operation.file_path), lexical(operation.new_path)]
        for later in operations[index + 1:]:
            for raw in (later.file_path, later.new_path):
                if raw and any(lexical(raw) == item or lexical(raw).startswith(item + os.sep) for item in affected):
                    raise ValueError("Cannot prepare dependent operations through a moved link; use separate tool calls")
    targets = []
    for operation in operations:
        raw = operation.file_path
        if operation.operation in (OperationType.ADD, OperationType.UPDATE):
            content = "\n".join(line.content for hunk in operation.hunks for line in hunk.lines if line.prefix == "+")
            targets.append(FileExecutionTarget("write", resolved.get(raw) or "", raw, content=content))
        else:
            targets.append(FileExecutionTarget("delete", entries.get(raw) or "", raw, role="entry"))
            if operation.operation is OperationType.MOVE:
                targets.append(FileExecutionTarget("write", entries.get(operation.new_path) or "",
                                                   operation.new_path or "", role="move_destination"))
    return tuple(targets)


def prepare_terminal_cwd(plan, env, *, workdir, session_key, task_id):
    """Pin the directory used by both foreground and background execution."""
    from tools.terminal_tool import _resolve_command_cwd, resolve_task_overrides
    from tools.environments.local import _msys_to_windows_path
    cwd = _resolve_command_cwd(workdir=workdir, default_cwd=plan.cwd,
        session_key=session_key, env_type=plan.env_type, env=env,
        mounted_host=getattr(env, "host_cwd", None) or plan.host_cwd)
    workspace = resolve_task_overrides(task_id).get("cwd") or plan.config["cwd"]
    if plan.env_type == "local":
        for value in (cwd, workspace):
            error = check_prepared_paths([value])
            if error:
                raise ValueError(error)
        target = Path(_msys_to_windows_path(cwd)).expanduser()
        if not target.is_absolute():
            target = Path(env.cwd) / target
        cwd = str(target.resolve())
        workspace = str(Path(_msys_to_windows_path(workspace)).expanduser().resolve())
    return cwd, workspace


def authorize_terminal(command, *, env, backend, cwd, workspace_root, task_id="default", session_id="", background=False, pty=False):
    if not execution_policy_available():
        return None
    shell = "bash" if backend == "local" else None
    if backend == "local" and background:
        from tools.environments.local import _find_shell
        shell = Path(_find_shell()).stem
    return enforce_tool_execution(_description(
        "terminal", {"command": command, "workdir": cwd, "background": background},
        backend=backend, cwd=cwd, workspace_root=workspace_root, task_id=task_id,
        session_id=session_id, shell=shell,
        environment=getattr(env, "env", None),
    ))


def dispatch_with_execution_policy(name, args, context, handler, *, prepared=False):
    """Registry fallback authorizes final arguments; prepared tools gate deeper."""
    if not execution_policy_available():
        return handler(args)
    from tools.registry import tool_error
    from hermes_cli.plugins_execution import freeze
    detached = thaw(freeze(args))
    ids = {key: str(context.get(key) or "") for key in ("task_id", "session_id", "tool_call_id", "turn_id")}
    with tool_execution_scope(name, detached, **ids):
        if not prepared:
            block = enforce_tool_execution(_description(name, detached, task_id=ids["task_id"], session_id=ids["session_id"]))
            if block:
                return tool_error(block, status="blocked")
        return handler(detached)
