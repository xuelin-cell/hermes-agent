"""First-stage write_file guard using the host's task-aware file resolver."""

from pathlib import Path


def _block(message: str) -> dict[str, str]:
    return {"action": "block", "message": f"security-guardrail: {message}"}


def _check_write(ctx, tool_name: str = "", args=None, task_id: str = "default", **kwargs):
    if tool_name != "write_file":
        return None
    configured = ctx.get_config("protected_directory", "")
    if not isinstance(configured, str) or not configured.strip():
        return _block("configure an absolute protected_directory before writing files")
    if not isinstance(args, dict) or not isinstance(args.get("path"), str) or not args["path"].strip():
        return _block("write_file requires a non-empty path")
    # Host-side resolution of UNC paths can authenticate to a network peer.
    if any(value.startswith(("\\\\", "//")) for value in (configured, args["path"])):
        return _block("this local-directory rule does not support network paths")
    try:
        root = Path(configured).expanduser()
        if not root.is_absolute():
            return _block("protected_directory must be an absolute local path")
        target = ctx.resolve_file_path(args["path"], task_id=task_id)
        if not isinstance(target, Path):
            return _block("this local-directory rule does not support remote file backends")
        root = root.resolve()
        target = target.resolve()
    except (OSError, ValueError, RuntimeError):
        return _block("could not resolve the protected directory or write target")
    if target.is_relative_to(root):
        return _block(f"protected_directory rule denied write to {target}")
    return None


def register(ctx):
    def before_tool(tool_name="", args=None, task_id="default", **kwargs):
        return _check_write(ctx, tool_name, args, task_id, **kwargs)

    ctx.register_hook("pre_tool_call", before_tool)
