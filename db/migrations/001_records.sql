-- Text IDs preserve existing prototype IDs. Each domain record is independently
-- persisted; JSONB preserves optional fields and immutable historical payloads.
CREATE SCHEMA IF NOT EXISTS twin;
CREATE TABLE twin.schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE twin.legacy_imports(sha256 text PRIMARY KEY, imported_at timestamptz NOT NULL DEFAULT now(), counts jsonb NOT NULL);
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['users','settings','imports','observations','facts','memory_overrides','integrations','calendar_events','gmail_cues','twin_days','activity_reports','model_connections','conversations','messages','avatar_designs','avatar_assets','avatar_requests','jobs']
  LOOP
    EXECUTE format('CREATE TABLE twin.%I (key text PRIMARY KEY, user_id text NOT NULL, position integer NOT NULL, payload jsonb NOT NULL CHECK(jsonb_typeof(payload) = ''object''))',name);
    EXECUTE format('CREATE INDEX ON twin.%I (user_id)',name);
    IF name <> 'users' THEN
      EXECUTE format('ALTER TABLE twin.%I ADD FOREIGN KEY (user_id) REFERENCES twin.users(key) DEFERRABLE INITIALLY DEFERRED',name);
      EXECUTE format('ALTER TABLE twin.%I ADD CHECK (payload->>''user_id'' = user_id)',name);
    END IF;
  END LOOP;
END $$;
CREATE TABLE twin.idempotency(key text PRIMARY KEY,payload jsonb NOT NULL);
CREATE INDEX ON twin.messages(user_id,(payload->>'conversation_id'),(payload->>'created_at'));
CREATE INDEX ON twin.activity_reports(user_id,(payload->>'created_at'));
CREATE INDEX ON twin.calendar_events(user_id,(payload->>'start_at'));
CREATE INDEX ON twin.facts USING gin(to_tsvector('english',payload->>'statement'));
CREATE INDEX ON twin.twin_days(user_id,(payload->>'local_date'));
INSERT INTO twin.schema_migrations(version) VALUES(1);
