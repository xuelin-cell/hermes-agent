"""Explicit Hermes schemas; name similarity never establishes execution trust."""

from ..guardrail.action import RuntimeOperation


DIRECT_TOOLS = {
    "web_search": "WebSearch", "browser_navigate": "WebFetch",
    "cronjob_manage": "CronJob", "todo_list": "TodoWrite",
    "session_search": "SessionSearch",
    "tool_search": "ToolSearch", "tool_describe": "ToolSearch",
}


def _terminal(execution, arguments):
    if execution.shell != "bash":
        raise ValueError("this adapter requires an actual Bash execution shell")
    return [("Bash", arguments, None)]


def _file(execution, arguments):
    if not execution.targets:
        raise ValueError("file tools require prepared targets")
    canonical = {"write_file": "Write", "patch": "Edit", "read_file": "Read"}.get(execution.tool_name)
    if canonical is None:
        canonical = "Glob" if arguments.get("target", "content") == "files" else "Grep"
    return [(canonical, {**arguments, "file_path": target.path, "path": target.path,
                         "content": target.content, "new_string": target.content},
             RuntimeOperation(target.operation)) for target in execution.targets]


def _web_extract(execution, arguments):
    urls = arguments.get("urls")
    if not isinstance(urls, list) or not urls:
        return [("WebFetch", {"url": ""}, None)]
    if any(not isinstance(url, str) for url in urls):
        raise ValueError("URL targets must be strings")
    # Retain batch user rules and inspect every actual normalized URL: the
    # source batch normalizer exposes only its first URL as the primary target.
    return [("WebBatchFetch", {"urls": urls}, None),
            *[("WebFetch", {"url": url}, None) for url in urls]]


def _delegate(execution, arguments):
    tasks = arguments.get("tasks")
    goals = [task.get("goal", "") for task in tasks if isinstance(task, dict)] if isinstance(tasks, list) else []
    description = arguments.get("goal") or "\n".join(goal for goal in goals if isinstance(goal, str))
    return [("DelegateTask", {**arguments, "task_description": description}, None)]


def _clarify(execution, arguments):
    questions = arguments.get("questions") or [{key: arguments[key] for key in ("question", "choices", "multi_select") if key in arguments}]
    return [("AskUserQuestion", {**arguments, "questions": questions}, None)]


def _memory(execution, arguments):
    return [("Memory", {**arguments, "old": arguments.get("old_text", ""),
                        "new": arguments.get("content") or arguments.get("new_text", "")}, None)]


def _process(execution, arguments):
    action = arguments.get("action", "")
    if action not in {"list", "poll", "log", "wait", "kill"}:
        return _unknown(execution, arguments)
    canonical = "TaskStop" if action == "kill" else "TaskOutput"
    return [(canonical, {**arguments, "task_id": arguments.get("session_id", "")}, None)]


def _skill(execution, arguments):
    return [("Skill", {**arguments, "skill": arguments.get("name", "")}, None)]


def _unknown(execution, arguments):
    # execute_code is Python here, not the source Bash alias. Unknown tools
    # retain the source unknown-execution-field check.
    return [("Hermes:" + execution.tool_name, arguments, None)]


_MAPPERS = {
    "terminal": _terminal, "web_extract": _web_extract, "delegate_task": _delegate,
    "process_manage": _process, "skill_view": _skill,
    "clarify": _clarify, "memory": _memory,
    **dict.fromkeys(("write_file", "patch", "read_file", "search_files"), _file),
}


def map_execution(execution, arguments):
    mapper = _MAPPERS.get(execution.tool_name)
    if mapper is not None:
        return mapper(execution, arguments)
    canonical = DIRECT_TOOLS.get(execution.tool_name)
    return [(canonical, arguments, None)] if canonical else _unknown(execution, arguments)
