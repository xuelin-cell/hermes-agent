-- Stable upload-only credentials, one pair per user. No expiry is attached.
CREATE TABLE IF NOT EXISTS langfuse_credentials (
    user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    public_key TEXT NOT NULL UNIQUE,
    secret_hash BYTEA NOT NULL CHECK (octet_length(secret_hash) = 32),
    secret_ciphertext BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
