/**
 * The schema as an append-only list of versioned SQL migrations. A migration is never edited
 * once applied anywhere: the runner records its checksum and refuses a changed one. Table names
 * and this SQL are static; caller data never reaches a statement except as a parameter.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'runs-and-source-lines',
    sql: `
CREATE TABLE qe_runs (
  project_id            text        NOT NULL,
  run_id                text        NOT NULL,
  ingestion_sequence    bigint      GENERATED ALWAYS AS IDENTITY,
  ingested_at           timestamptz NOT NULL DEFAULT now(),
  source_locator        text        NOT NULL,
  content_fingerprint   text        NOT NULL,
  fingerprint_version   smallint    NOT NULL,
  protocol_versions     text[]      NOT NULL,
  source_line_count     integer     NOT NULL,
  attachments_verified  boolean     NOT NULL,
  validation_summary    jsonb       NOT NULL,
  CONSTRAINT qe_runs_pkey PRIMARY KEY (project_id, run_id),
  CONSTRAINT qe_runs_ingestion_sequence_key UNIQUE (ingestion_sequence),
  CONSTRAINT qe_runs_project_id_check CHECK (project_id <> ''),
  CONSTRAINT qe_runs_run_id_check CHECK (run_id <> ''),
  CONSTRAINT qe_runs_content_fingerprint_check CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT qe_runs_source_line_count_check CHECK (source_line_count > 0)
);

COMMENT ON TABLE qe_runs IS
  'One complete, validator-valid run per (project_id, run_id). The raw source lines are the durable truth; everything else is derived or provenance.';
COMMENT ON COLUMN qe_runs.ingestion_sequence IS
  'Out-of-band ingestion ordering aid from a database identity: not protocol chronology, not a cross-session event order, gaps after rollback are normal.';
COMMENT ON COLUMN qe_runs.source_locator IS
  'Where the run was read from at first ingestion. Provenance only: never an identity or a deduplication key.';
COMMENT ON COLUMN qe_runs.content_fingerprint IS
  'SHA-256 over the sorted canonical digests of the unique accepted and ignored source lines: independent of property order, whitespace, file enumeration, and identical duplicate lines.';
COMMENT ON COLUMN qe_runs.attachments_verified IS
  'True when attachment bytes were hash-verified at ingestion; replay from this store cannot re-verify them.';
COMMENT ON COLUMN qe_runs.validation_summary IS
  'The validator summary at ingestion, kept to detect a disagreeing replay; never the source of test outcomes.';

CREATE TABLE qe_run_source_lines (
  project_id        text     NOT NULL,
  run_id            text     NOT NULL,
  storage_ordinal   integer  NOT NULL,
  event_id          text     NOT NULL,
  session_id        text     NOT NULL,
  sequence          bigint   NOT NULL,
  event_type        text     NOT NULL,
  protocol_version  text     NOT NULL,
  canonical_sha256  text     NOT NULL,
  disposition       text     NOT NULL,
  raw_line          text     NOT NULL,
  source_file       text     NOT NULL,
  source_line       integer  NOT NULL,
  CONSTRAINT qe_run_source_lines_pkey PRIMARY KEY (project_id, run_id, storage_ordinal),
  CONSTRAINT qe_run_source_lines_run_fkey FOREIGN KEY (project_id, run_id)
    REFERENCES qe_runs (project_id, run_id),
  CONSTRAINT qe_run_source_lines_disposition_check
    CHECK (disposition IN ('accepted', 'ignored', 'duplicate')),
  CONSTRAINT qe_run_source_lines_canonical_sha256_check CHECK (canonical_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT qe_run_source_lines_storage_ordinal_check CHECK (storage_ordinal >= 0),
  CONSTRAINT qe_run_source_lines_sequence_check CHECK (sequence >= 1)
);

COMMENT ON TABLE qe_run_source_lines IS
  'The original validator-accepted JSON lines of a run. raw_line is authoritative; the other columns are indexes copied from it. Identical duplicate lines are kept, so event_id is not unique.';
COMMENT ON COLUMN qe_run_source_lines.storage_ordinal IS
  'Storage and replay order only: session id by code unit, then session sequence, then event id, then source occurrence. It does not order events across sessions.';

CREATE INDEX qe_run_source_lines_session_idx
  ON qe_run_source_lines (project_id, run_id, session_id, sequence);
`,
  },
];
