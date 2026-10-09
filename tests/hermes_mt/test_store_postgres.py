"""验证 Entry PostgreSQL Store 的事务、约束和凭据恢复契约。"""

from __future__ import annotations

import asyncio
import hashlib

import asyncpg
import pytest
from cryptography.fernet import Fernet

from entry.crypto import CredentialCipher
from entry.db import Database
from entry.store import Store


async def _store(url: str) -> tuple[Database, Store]:
    database = Database(url, min_size=1, max_size=3)
    await database.connect()
    cipher = CredentialCipher(Fernet.generate_key().decode())
    return database, Store(database, cipher)


@pytest.mark.asyncio
async def test_login_persists_hashed_session_model_config_and_encrypted_key(
    postgres_database_url: str,
) -> None:
    database, store = await _store(postgres_database_url)
    login = await store.finish_login(
        user_id="user-a",
        phone="13812345678",
        api_key="key-one",
        endpoint=("https://models.example/v1", "model-a"),
        catalog=[("model-a", "https://models.example/v1")],
        ttl_s=3600,
        upstream_expires_at_ms=None,
        login_method="sms",
    )

    assert login.has_api_key is True
    assert await store.masked_phone("user-a") == "138****5678"
    assert (await store.get_session(login.session.sid)).user_id == "user-a"  # type: ignore[union-attr]

    async with database.acquire() as connection:
        session_row = await connection.fetchrow("SELECT session_token_hash FROM auth_sessions")
        credential_row = await connection.fetchrow(
            "SELECT api_key_ciphertext FROM tenant_credentials WHERE user_id = 'user-a'"
        )
    assert session_row["session_token_hash"] == hashlib.sha256(login.session.sid.encode()).digest()
    assert login.session.sid.encode() not in session_row["session_token_hash"]
    assert b"key-one" not in credential_row["api_key_ciphertext"]

    context = await store.get_tenant_context("user-a")
    assert context.api_key == "key-one"
    assert context.endpoint == ("https://models.example/v1", "model-a")
    assert context.catalog == [("model-a", "https://models.example/v1")]
    await database.close()


@pytest.mark.asyncio
async def test_empty_login_values_preserve_existing_key_and_plan(
    postgres_database_url: str,
) -> None:
    database, store = await _store(postgres_database_url)
    await store.finish_login(
        user_id="user-a",
        phone="",
        api_key="key-one",
        endpoint=("https://models.example/v1", "model-a"),
        catalog=[("model-a", "https://models.example/v1")],
        ttl_s=3600,
        upstream_expires_at_ms=None,
        login_method="dev",
    )

    second = await store.finish_login(
        user_id="user-a",
        phone="",
        api_key="",
        endpoint=("", ""),
        catalog=[],
        ttl_s=3600,
        upstream_expires_at_ms=None,
        login_method="dev",
    )

    context = await store.get_tenant_context("user-a")
    assert second.has_api_key is True
    assert context.api_key == "key-one"
    assert context.endpoint == ("https://models.example/v1", "model-a")
    await database.close()


@pytest.mark.asyncio
async def test_concurrent_container_token_creation_returns_one_token(
    postgres_database_url: str,
) -> None:
    database, store = await _store(postgres_database_url)
    await store.finish_login(
        user_id="user-a",
        phone="",
        api_key="",
        endpoint=None,
        catalog=None,
        ttl_s=3600,
        upstream_expires_at_ms=None,
        login_method="dev",
    )

    tokens = await asyncio.gather(*(store.ensure_tenant_token("user-a") for _ in range(8)))

    assert len(set(tokens)) == 1
    context = await store.get_tenant_context("user-a")
    assert context.container_token == tokens[0]
    await database.close()


@pytest.mark.asyncio
async def test_runtime_state_accepts_only_starting_running_and_stopped(
    postgres_database_url: str,
) -> None:
    """租户运行态只允许已经确认的三个状态。"""
    database, store = await _store(postgres_database_url)
    await store.finish_login(
        user_id="user-a",
        phone="",
        api_key="",
        endpoint=None,
        catalog=None,
        ttl_s=3600,
        upstream_expires_at_ms=None,
        login_method="dev",
    )
    await store.ensure_tenant_token("user-a")

    async with database.acquire() as connection:
        assert await connection.fetchval(
            "SELECT state FROM tenant_runtime WHERE user_id = 'user-a'"
        ) == "stopped"

    for state in ("starting", "running", "stopped"):
        await store.set_tenant_state("user-a", state)
        async with database.acquire() as connection:
            assert await connection.fetchval(
                "SELECT state FROM tenant_runtime WHERE user_id = 'user-a'"
            ) == state

    with pytest.raises(asyncpg.CheckViolationError):
        await store.set_tenant_state("user-a", "none")
    await database.close()


@pytest.mark.asyncio
async def test_optimized_schema_omits_retired_columns(
    postgres_database_url: str,
) -> None:
    """全新数据库不再创建已经删除的旧字段。"""
    database, _ = await _store(postgres_database_url)
    async with database.acquire() as connection:
        rows = await connection.fetch(
            """
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN ('users', 'tenant_credentials')
            """
        )
    columns = {(row["table_name"], row["column_name"]) for row in rows}
    assert ("users", "masked_phone") in columns
    assert ("users", "display_name") not in columns
    assert ("users", "updated_at") not in columns
    assert ("tenant_credentials", "encryption_key_id") not in columns
    await database.close()


@pytest.mark.asyncio
async def test_disabled_user_session_is_rejected(postgres_database_url: str) -> None:
    database, store = await _store(postgres_database_url)
    login = await store.finish_login(
        user_id="user-a",
        phone="",
        api_key="",
        endpoint=None,
        catalog=None,
        ttl_s=3600,
        upstream_expires_at_ms=None,
        login_method="dev",
    )
    async with database.acquire() as connection:
        await connection.execute("UPDATE users SET status = 'disabled' WHERE user_id = 'user-a'")

    assert await store.get_session(login.session.sid) is None
    await database.close()


@pytest.mark.asyncio
async def test_idle_query_excludes_live_websocket_user(postgres_database_url: str) -> None:
    database, store = await _store(postgres_database_url)
    for user_id in ("user-a", "user-b"):
        await store.finish_login(
            user_id=user_id,
            phone="",
            api_key="",
            endpoint=None,
            catalog=None,
            ttl_s=3600,
            upstream_expires_at_ms=None,
            login_method="dev",
        )
        await store.ensure_tenant_token(user_id)
        await store.set_tenant_state(user_id, "running")
    async with database.acquire() as connection:
        await connection.execute(
            "UPDATE tenant_runtime SET last_activity_at = now() - interval '2 hours'"
        )

    assert await store.idle_tenants(3600, exclude={"user-a"}) == ["user-b"]
    await database.close()


async def _user_with_runtime(store: Store, user_id: str) -> None:
    await store.finish_login(
        user_id=user_id, phone="13800000000", api_key="k", endpoint=("https://m/v1", "m"),
        catalog=[("m", "https://m/v1")], ttl_s=3600, upstream_expires_at_ms=None, login_method="sms",
    )
    await store.ensure_tenant_token(user_id)


@pytest.mark.asyncio
async def test_record_sandbox_round_trips_traffic_token_and_clears_with_sandbox(
    postgres_database_url: str,
) -> None:
    database, store = await _store(postgres_database_url)
    await _user_with_runtime(store, "user-t")
    epoch = await store.next_epoch("user-t")
    await store.record_sandbox("user-t", "sb-private", "tpl-x", epoch, traffic_token="tok-" + "x" * 60)

    rt = await store.get_runtime("user-t")
    assert rt.sandbox_id == "sb-private" and rt.traffic_token == "tok-" + "x" * 60
    async with database.acquire() as connection:
        raw = await connection.fetchval("SELECT traffic_token_ciphertext FROM tenant_runtime WHERE user_id = 'user-t'")
    assert raw is not None and b"tok-" not in raw  # 落库的是密文

    await store.set_sandbox_id("user-t", None)
    rt = await store.get_runtime("user-t")
    assert rt.sandbox_id == "" and rt.traffic_token == ""
    async with database.acquire() as connection:
        assert await connection.fetchval("SELECT traffic_token_ciphertext FROM tenant_runtime WHERE user_id = 'user-t'") is None

    # 公开访问的实例：没有令牌，列是 NULL
    await store.record_sandbox("user-t", "sb-public", "tpl-x", epoch + 1)
    assert (await store.get_runtime("user-t")).traffic_token == ""
    assert await store.backup_candidates() == ["user-t"]
    await database.close()


@pytest.mark.asyncio
async def test_advisory_lock_is_exclusive_across_connections(postgres_database_url: str) -> None:
    database, store = await _store(postgres_database_url)
    order: list[str] = []
    entered = asyncio.Event()
    release = asyncio.Event()

    async def holder() -> None:
        async with store.advisory_lock("user-l"):
            order.append("a-in")
            entered.set()
            await release.wait()
            order.append("a-out")

    async def waiter() -> None:
        await entered.wait()
        async with store.advisory_lock("user-l"):
            order.append("b-in")
            order.append("b-out")

    task_a = asyncio.create_task(holder())
    task_b = asyncio.create_task(waiter())
    await entered.wait()
    await asyncio.sleep(0.3)
    assert order == ["a-in"]  # b 在等锁
    release.set()
    await asyncio.gather(task_a, task_b)
    assert order == ["a-in", "a-out", "b-in", "b-out"]

    # 不同用户互不影响：同时拿得到
    async with store.advisory_lock("user-x"):
        async with store.advisory_lock("user-y"):
            pass
    await database.close()


@pytest.mark.asyncio
async def test_cron_due_query_wakes_each_time_point_once(postgres_database_url: str) -> None:
    """停着的实例、任务快到点 ⇒ 叫；同一个时间点叫过就不再叫；在跑的、在删的、停用的用户不叫。"""
    from datetime import datetime, timedelta, timezone

    database, store = await _store(postgres_database_url)
    for user_id in ("u-due", "u-later", "u-running", "u-draining", "u-disabled", "u-none"):
        await _user_with_runtime(store, user_id)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    soon, later = now + timedelta(seconds=60), now + timedelta(hours=3)
    await store.set_next_cron("u-due", soon)
    await store.set_next_cron("u-later", later)
    await store.set_next_cron("u-running", soon)
    await store.set_tenant_state("u-running", "running")
    await store.set_next_cron("u-draining", soon)
    await store.set_lifecycle("u-draining", "deleting")
    await store.set_next_cron("u-disabled", now - timedelta(minutes=5))
    async with database.acquire() as connection:
        await connection.execute("UPDATE users SET status = 'disabled' WHERE user_id = 'u-disabled'")

    assert await store.cron_due_tenants(90) == [("u-due", soon)]
    await store.mark_cron_woken("u-due", soon)
    assert await store.cron_due_tenants(90) == []
    # 实例下次停下时报了新的时间点：又可以叫了；报 None（没任务了）就不叫
    nxt = soon + timedelta(days=1)
    await store.set_next_cron("u-due", nxt)
    assert await store.cron_due_tenants(24 * 3600 + 120) == [("u-later", later), ("u-due", nxt)]
    await store.set_next_cron("u-due", None)
    assert [u for u, _ in await store.cron_due_tenants(24 * 3600 + 120)] == ["u-later"]
    await database.close()
