"""验证本地多租户 PostgreSQL、Entry 健康和开发登录链路。"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request


EXPECTED_TABLES = {
    "audit_events",
    "auth_sessions",
    "schema_migrations",
    "tenant_credentials",
    "tenant_model_config",
    "tenant_runtime",
    "users",
}


def _docker(*arguments: str) -> str:
    result = subprocess.run(
        ["docker", *arguments],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout.strip()


def _container_environment(name: str) -> dict[str, str]:
    raw = _docker("inspect", name, "--format", "{{json .Config.Env}}")
    values = json.loads(raw)
    return dict(item.split("=", 1) for item in values if "=" in item)


def _wait_entry_healthy(timeout_s: int = 60) -> str:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        status = _docker(
            "inspect",
            "hermes-mt-entry",
            "--format",
            "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
        )
        if status == "healthy":
            return status
        time.sleep(1)
    return status


def _request(opener, url: str, *, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
        method="POST" if data is not None else "GET",
    )
    try:
        with opener.open(request, timeout=15) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"raw": raw[:200]}
        return exc.code, payload


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="验证本地 Entry PostgreSQL 迁移")
    parser.add_argument("--base-url", default="http://127.0.0.1:18081/hermes")
    parser.add_argument("--user", default="postgres-smoke")
    parser.add_argument("--skip-login", action="store_true")
    parser.add_argument("--restart-entry", action="store_true")
    parser.add_argument("--check-outage", action="store_true")
    args = parser.parse_args()

    postgres_status = _docker("inspect", "hermes-mt-postgres", "--format", "{{.State.Status}}")
    entry_health = _wait_entry_healthy()
    if postgres_status != "running" or entry_health != "healthy":
        raise RuntimeError(
            f"容器未就绪: postgres={postgres_status}, entry={entry_health}"
        )

    environment = _container_environment("hermes-mt-postgres")
    query = "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    output = _docker(
        "exec",
        "hermes-mt-postgres",
        "psql",
        "-U",
        environment["POSTGRES_USER"],
        "-d",
        environment["POSTGRES_DB"],
        "-Atc",
        query,
    )
    tables = {line for line in output.splitlines() if line}
    missing = EXPECTED_TABLES - tables
    if missing:
        raise RuntimeError(f"缺少数据库表: {', '.join(sorted(missing))}")

    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
    status, health = _request(opener, f"{args.base_url}/__entry/health")
    if status != 200 or not health.get("ok") or health.get("database") != "ok":
        raise RuntimeError(f"Entry 健康检查失败: HTTP {status} {health}")

    if not args.skip_login:
        status, login = _request(
            opener,
            f"{args.base_url}/__entry/dev-login",
            body={"user": args.user},
        )
        if status == 404:
            print("SKIP 开发登录未启用")
        elif status != 200 or not login.get("ok"):
            raise RuntimeError(f"开发登录失败: HTTP {status} {login}")
        else:
            status, me = _request(opener, f"{args.base_url}/__entry/me")
            if status != 200 or me.get("user_id") != args.user:
                raise RuntimeError(f"登录 Cookie 验证失败: HTTP {status} {me}")
            print(f"PASS 开发登录与 PostgreSQL 会话: {args.user}")
            if args.restart_entry:
                _docker("restart", "hermes-mt-entry")
                if _wait_entry_healthy() != "healthy":
                    raise RuntimeError("Entry 重启后未在 60 秒内恢复健康")
                status, me = _request(opener, f"{args.base_url}/__entry/me")
                if status != 200 or me.get("user_id") != args.user:
                    raise RuntimeError(f"Entry 重启后会话未恢复: HTTP {status} {me}")
                print("PASS Entry 重启后 PostgreSQL 会话仍有效")
            if args.check_outage:
                outage_error: RuntimeError | None = None
                _docker("stop", "hermes-mt-postgres")
                try:
                    status, payload = _request(opener, f"{args.base_url}/__entry/me")
                    if status != 503 or payload != {"error": "database_unavailable"}:
                        outage_error = RuntimeError(
                            f"数据库中断响应不符合预期: HTTP {status} {payload}"
                        )
                finally:
                    _docker("start", "hermes-mt-postgres")
                    deadline = time.monotonic() + 60
                    while time.monotonic() < deadline:
                        status, health = _request(opener, f"{args.base_url}/__entry/health")
                        if status == 200 and health.get("database") == "ok":
                            break
                        time.sleep(1)
                    else:
                        raise RuntimeError("PostgreSQL 恢复后 Entry 未在 60 秒内恢复健康")
                if outage_error is not None:
                    raise outage_error
                print("PASS PostgreSQL 中断返回 503 且恢复后继续服务")

    print("PASS PostgreSQL 结构完整")
    print("PASS Entry 数据库健康")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (KeyError, OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
