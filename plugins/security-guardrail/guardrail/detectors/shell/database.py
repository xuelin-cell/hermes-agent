"""Database client operations that require explicit approval."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from ...action import ToolType
from ...baseline_rules import result_for
from ...baseline_rules.shell import ask as ask_rules
from .profile import profile_shell_command
from ...signals import BaselineResult

if TYPE_CHECKING:
    from ...action import RuntimeAction


_DATABASE_CLIENTS = frozenset({"clickhouse-client", "cqlsh", "duckdb", "mariadb", "mysql", "psql", "sqlite3", "sqlcmd"})
_DESTRUCTIVE_SQL_RE = re.compile(
    r"\b(?:DROP\s+(?:DATABASE|FUNCTION|INDEX|MATERIALIZED\s+VIEW|PROCEDURE|SCHEMA|SEQUENCE|TABLE|TRIGGER|TYPE|VIEW)|"
    r"TRUNCATE\s+(?:TABLE\s+)?|ALTER\s+TABLE\s+\S+\s+DROP\s+(?:COLUMN|CONSTRAINT))\b",
    re.IGNORECASE,
)
_MASS_DML_RE = re.compile(r"\b(?:DELETE\s+FROM|UPDATE\s+\S+\s+SET)\b", re.IGNORECASE)
_TRIVIAL_WHERE_RE = re.compile(r"\bWHERE\s+(?:1\s*=\s*1|TRUE)\b", re.IGNORECASE)
_REDIS_FLUSH_RE = re.compile(r"\b(?:FLUSHALL|FLUSHDB)\b", re.IGNORECASE)
_MONGO_DESTRUCTIVE_RE = re.compile(
    r"\b(?:dropDatabase\s*\(|(?:db\.)?[A-Za-z_$][\w$]*\.drop\s*\(|deleteMany\s*\(\s*\{\s*\}\s*\))",
    re.IGNORECASE,
)


def detect_database_destructive_operation(action: RuntimeAction) -> BaselineResult:
    """Detect destructive SQL passed directly to a database client."""
    if action.tool_type != ToolType.SHELL:
        return BaselineResult.no_signal()
    for invocation in profile_shell_command(action.normalized_payload).invocations:
        command = invocation.canonical_name
        segment = invocation.raw_segment
        sql = _strip_sql_literals_and_comments(" ".join(invocation.args))
        if command in _DATABASE_CLIENTS and (_DESTRUCTIVE_SQL_RE.search(sql) or _contains_mass_dml(sql)):
            return result_for(ask_rules.DATABASE_DESTRUCTIVE_OPERATION, action)
        if command == "redis-cli" and _REDIS_FLUSH_RE.search(segment):
            return result_for(ask_rules.DATABASE_DESTRUCTIVE_OPERATION, action)
        if command in {"mongo", "mongosh"} and _MONGO_DESTRUCTIVE_RE.search(segment):
            return result_for(ask_rules.DATABASE_DESTRUCTIVE_OPERATION, action)
    return BaselineResult.no_signal()


def _contains_mass_dml(segment: str) -> bool:
    for statement in segment.split(";"):
        match = _MASS_DML_RE.search(statement)
        if match is None:
            continue
        sql = statement[match.start() :]
        if _TRIVIAL_WHERE_RE.search(sql) or re.search(r"\bWHERE\b", sql, re.IGNORECASE) is None:
            return True
    return False


def _strip_sql_literals_and_comments(sql: str) -> str:
    """Remove SQL literals and comments while retaining token boundaries."""
    cleaned: list[str] = []
    index = 0
    while index < len(sql):
        if sql.startswith("--", index) or (sql[index] == "#" and (index == 0 or sql[index - 1].isspace())):
            newline = sql.find("\n", index)
            index = len(sql) if newline < 0 else newline
            cleaned.append(" ")
            continue
        if sql.startswith("/*", index):
            end = sql.find("*/", index + 2)
            index = len(sql) if end < 0 else end + 2
            cleaned.append(" ")
            continue
        quote = sql[index]
        if quote not in {"'", '"', "`"}:
            cleaned.append(quote)
            index += 1
            continue
        index += 1
        while index < len(sql):
            if sql[index] == quote:
                if index + 1 < len(sql) and sql[index + 1] == quote:
                    index += 2
                    continue
                index += 1
                break
            if sql[index] == "\\" and index + 1 < len(sql):
                index += 2
            else:
                index += 1
        cleaned.append(" quoted_value ")
    return "".join(cleaned)
