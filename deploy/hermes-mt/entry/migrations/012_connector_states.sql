-- Each profile's connector state (keys, encrypted credential store, which connectors are on),
-- encrypted with the credential key. Written after every connector change instead of archiving
-- the instance; bootstrap sends it back and the instance keeps it unless its own store is newer.
CREATE TABLE IF NOT EXISTS connector_states (
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    profile TEXT NOT NULL,
    snapshot_ciphertext BYTEA NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, profile)
);
