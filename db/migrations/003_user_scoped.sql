-- Per-user storage: every row is found, locked, and deleted by its owner.
-- 1. Idempotency replay records get an owner; keys are unique per user, not globally.
ALTER TABLE twin.idempotency ADD COLUMN user_id text;
-- Owner: the payload's user_id, else a user id embedded in the key
-- (planning:<user>:..., voice-start:<user>:...), else the first user.
UPDATE twin.idempotency AS i SET user_id = COALESCE(
  i.payload->>'user_id',
  (SELECT u.key FROM twin.users u
    WHERE i.key LIKE '%:' || u.key || ':%' OR i.key LIKE '%:' || u.key
    ORDER BY length(u.key) DESC LIMIT 1),
  (SELECT key FROM twin.users ORDER BY position LIMIT 1),
  'user_demo'
);
ALTER TABLE twin.idempotency ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE twin.idempotency DROP CONSTRAINT idempotency_pkey;
ALTER TABLE twin.idempotency ADD PRIMARY KEY (user_id, key);

-- 2. Positions count within each user, so one user's writes never renumber another's rows.
--    Observations have no id; their key becomes <user_id>:<position>.
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['users','settings','imports','observations','facts','memory_overrides','integrations','calendar_events','gmail_cues','twin_days','activity_reports','model_connections','conversations','messages','voice_sessions','avatar_designs','avatar_assets','avatar_requests','jobs']
  LOOP
    EXECUTE format(
      'UPDATE twin.%I AS t SET position = r.n FROM (SELECT key, row_number() OVER (PARTITION BY user_id ORDER BY position) - 1 AS n FROM twin.%I) AS r WHERE t.key = r.key',
      name, name);
  END LOOP;
END $$;
UPDATE twin.observations SET key = user_id || ':' || position;

-- 3. The worker finds due jobs and existing dedupe keys without scanning every row.
CREATE INDEX IF NOT EXISTS jobs_due_idx ON twin.jobs ((payload->>'status'), (payload->>'run_after'))
  WHERE payload->>'status' IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS jobs_dedupe_idx ON twin.jobs ((payload->>'dedupe_key'));

INSERT INTO twin.schema_migrations(version) VALUES(3) ON CONFLICT(version) DO NOTHING;
