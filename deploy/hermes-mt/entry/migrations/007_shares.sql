-- Browser-held MaaS credentials are never stored here; only public payloads and lifecycle state.
CREATE TABLE IF NOT EXISTS cloud_shares (
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('conversation', 'artifact')),
    share_key TEXT NOT NULL,
    record JSONB,
    pending JSONB,
    payload BYTEA,
    PRIMARY KEY (user_id, kind, share_key)
);
