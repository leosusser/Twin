CREATE TABLE IF NOT EXISTS twin.voice_sessions (
  key text PRIMARY KEY,
  user_id text NOT NULL REFERENCES twin.users(key) DEFERRABLE INITIALLY DEFERRED,
  position integer NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload) = 'object'),
  CHECK (payload->>'user_id' = user_id)
);
CREATE INDEX IF NOT EXISTS voice_sessions_user_id_idx ON twin.voice_sessions(user_id);
INSERT INTO twin.schema_migrations(version) VALUES(2) ON CONFLICT(version) DO NOTHING;
