-- Execution queue and agent tokens (ADR-0014, ADR-0015).
-- Jobs are queued in PostgreSQL (SELECT … FOR UPDATE SKIP LOCKED) — the backlog's "approved equivalent" of a broker
-- for 1.0; the platform reaches it through an IJobQueue interface so RabbitMQ can replace it without API changes.
BEGIN;
SET search_path = atimtha, public;

ALTER TABLE execution_agent
  ADD COLUMN token_hash text UNIQUE;                    -- SHA-256 hex of the agent token (shown once at creation)

ALTER TABLE execution
  ADD COLUMN job              jsonb,                    -- job document frozen at request time (reproducible runs)
  ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN requeue_count    smallint NOT NULL DEFAULT 0,
  ADD COLUMN error            text;                     -- infrastructure error (agent lost, job expired…)

CREATE INDEX execution_queue ON execution (engine, queued_at) WHERE status = 'queued';
CREATE INDEX execution_agent_busy ON execution (agent_id) WHERE status IN ('assigned', 'running');

-- Agents authenticate with a token; the API must find the agent before it knows the organisation (RLS),
-- so this lookup runs as the owner and returns only the agent that holds exactly this token hash.
CREATE FUNCTION agent_by_token(p_token_hash text)
RETURNS TABLE (agent_id uuid, organization_id uuid, status agent_status)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = atimtha, pg_temp
AS $$
  SELECT a.id, a.organization_id, a.status
  FROM execution_agent a
  WHERE a.token_hash = p_token_hash AND a.revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION agent_by_token(text) FROM PUBLIC;

-- Maintenance (all organisations): jobs whose agent stopped sending heartbeats.
CREATE FUNCTION stale_jobs(p_silence interval)
RETURNS TABLE (execution_id uuid, organization_id uuid, requeue_count smallint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = atimtha, pg_temp
AS $$
  SELECT e.id, e.organization_id, e.requeue_count
  FROM execution e
  JOIN execution_agent a ON a.id = e.agent_id
  WHERE e.status IN ('assigned', 'running')
    AND (a.last_heartbeat_at IS NULL OR a.last_heartbeat_at < now() - p_silence)
$$;
REVOKE ALL ON FUNCTION stale_jobs(interval) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atimtha_app') THEN
    GRANT EXECUTE ON FUNCTION agent_by_token(text) TO atimtha_app;
    GRANT EXECUTE ON FUNCTION stale_jobs(interval) TO atimtha_app;
  END IF;
END $$;

COMMIT;
