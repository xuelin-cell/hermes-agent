-- Non-secret receipts survive Entry restart; credentials and grant handles never do.
CREATE TABLE IF NOT EXISTS cloud_drive_operations (
    operation_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    login_id TEXT NOT NULL,
    result JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, operation_id)
);
CREATE INDEX IF NOT EXISTS cloud_drive_operations_owner_idx ON cloud_drive_operations(user_id, updated_at);
