-- Sharding a run across agents (backlog §6/§10): a parent run (shard_total set, no parent) is never claimed; its
-- children (parent set, shard_index 1..shard_total) each run one slice (Playwright --shard=i/n) on any free agent.
-- The parent's status and counts are rolled up from the children when they finish.
BEGIN;
SET search_path = atimtha, public;

ALTER TABLE execution
  ADD COLUMN parent_execution_id uuid,
  ADD COLUMN shard_index smallint,
  ADD COLUMN shard_total smallint,
  ADD FOREIGN KEY (parent_execution_id, organization_id) REFERENCES execution(id, organization_id),
  ADD CONSTRAINT execution_shard_check CHECK (
    (shard_total IS NULL AND shard_index IS NULL AND parent_execution_id IS NULL)
    OR (shard_total BETWEEN 2 AND 8 AND (
         (parent_execution_id IS NULL AND shard_index IS NULL)
      OR (parent_execution_id IS NOT NULL AND shard_index BETWEEN 1 AND shard_total)))
  );

CREATE INDEX execution_parent ON execution (parent_execution_id) WHERE parent_execution_id IS NOT NULL;

-- a schedule may start its runs sharded too
ALTER TABLE run_schedule ADD COLUMN shards smallint CHECK (shards BETWEEN 2 AND 8);

COMMIT;
