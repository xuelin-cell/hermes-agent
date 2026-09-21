"""验证 Entry PostgreSQL Store 的事务、约束和凭据恢复契约。"""

from __future__ import annotations

import asyncio
import hashlib

import pytest
from cryptography.fernet import Fernet

from entry.crypto import CredentialCipher
from entry.db import Database
from entry.store import Store


async def _store(url: str) -> tuple[Database, Store]:
    database = Database(url, min_size=1, max_size=3)
    await database.connect()
    cipher = CredentialCipher(Fernet.generate_key().decode(), "test-v1")
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
    assert await store.display_name("user-a") == "138****5678"
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
