-- Central channels: exactly three tables. Execution receipts live in the instance.
CREATE TABLE messaging_bindings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id),
    platform TEXT NOT NULL,
    bot_key TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'sms-login',
    config JSONB NOT NULL DEFAULT '{}',
    secret_enc BYTEA NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    connection_state TEXT NOT NULL DEFAULT 'stopped',
    error_code TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE(id, user_id),
    CHECK (jsonb_typeof(config) = 'object')
);
CREATE UNIQUE INDEX messaging_bot_owner ON messaging_bindings(platform, bot_key) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX messaging_user_platform ON messaging_bindings(user_id, platform) WHERE deleted_at IS NULL;

CREATE TABLE messaging_inbox (
    delivery_id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    binding_revision BIGINT NOT NULL,
    platform TEXT NOT NULL,
    bot_key TEXT NOT NULL,
    external_chat_id TEXT NOT NULL,
    external_message_id TEXT NOT NULL,
    payload JSONB,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN
        ('queued','dispatching','accepted','running','completed','failed','uncertain','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_owner TEXT,
    lease_until TIMESTAMPTZ,
    instance_epoch BIGINT,
    execution_ref TEXT,
    error_code TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(platform, bot_key, external_chat_id, external_message_id),
    FOREIGN KEY(binding_id,user_id) REFERENCES messaging_bindings(id,user_id)
);
CREATE UNIQUE INDEX messaging_one_active_user ON messaging_inbox(user_id) WHERE state IN('dispatching','accepted','running');
CREATE INDEX messaging_inbox_ready ON messaging_inbox(next_at, created_at) WHERE state='queued';
CREATE INDEX messaging_user_queue ON messaging_inbox(user_id, created_at, delivery_id) WHERE state='queued';
CREATE INDEX messaging_inbox_leases ON messaging_inbox(lease_until) WHERE lease_owner IS NOT NULL;

CREATE TABLE messaging_outbox (
    outbound_id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES messaging_inbox(delivery_id),
    part_index INTEGER NOT NULL DEFAULT 0 CHECK (part_index >= 0),
    binding_revision BIGINT NOT NULL,
    payload JSONB NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed','unknown','cancelled')),
    platform_message_id TEXT,
    platform_ack JSONB,
    attempts INTEGER NOT NULL DEFAULT 0,
    error_code TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(delivery_id, part_index)
);
CREATE INDEX messaging_outbox_pending ON messaging_outbox(created_at) WHERE state='pending';
