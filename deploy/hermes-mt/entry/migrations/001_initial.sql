-- 创建 Entry 平台数据的初始 PostgreSQL 结构。

CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    masked_phone TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    session_token_hash BYTEA PRIMARY KEY CHECK (octet_length(session_token_hash) = 32),
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    upstream_expires_at TIMESTAMPTZ,
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS tenant_runtime (
    user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'stopped')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    state_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_runtime_idle_idx
    ON tenant_runtime(last_activity_at)
    WHERE state = 'running';

CREATE TABLE IF NOT EXISTS tenant_model_config (
    user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    default_base_url TEXT,
    default_model TEXT,
    model_catalog JSONB NOT NULL DEFAULT '[]'::jsonb,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(model_catalog) = 'array')
);

CREATE TABLE IF NOT EXISTS tenant_credentials (
    user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    api_key_ciphertext BYTEA,
    container_token_ciphertext BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (api_key_ciphertext IS NOT NULL OR container_token_ciphertext IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS audit_events (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id TEXT,
    event_type TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX IF NOT EXISTS audit_events_user_time_idx
    ON audit_events(user_id, occurred_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS audit_events_time_idx
    ON audit_events(occurred_at DESC, event_id DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
