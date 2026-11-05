-- User-owned instance settings kept by entry as the source of truth, so a change is durable
-- without archiving the whole instance. Bootstrap re-applies them over the restored config.yaml.
-- settings.skills = {skill_name: enabled}: only the skills the user toggled, newest wins.
CREATE TABLE IF NOT EXISTS profile_settings (
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    profile TEXT NOT NULL DEFAULT 'default',
    settings JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
    revision BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, profile)
);
