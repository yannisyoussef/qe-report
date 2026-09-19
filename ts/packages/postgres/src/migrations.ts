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
  {
    version: 2,
    name: 'blobs-and-run-blobs',
    sql: `
CREATE TABLE qe_blobs (
  sha256       text        NOT NULL,
  size_bytes   bigint      NOT NULL,
  storage_key  text        NOT NULL,
  stored_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qe_blobs_pkey PRIMARY KEY (sha256),
  CONSTRAINT qe_blobs_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT qe_blobs_size_bytes_check CHECK (size_bytes >= 0),
  CONSTRAINT qe_blobs_storage_key_check
    CHECK (storage_key ~ '^[A-Za-z0-9/._-]+$' AND left(storage_key, 1) <> '/'
           AND storage_key !~ '(^|/)[.][.]?(/|$)')
);

COMMENT ON TABLE qe_blobs IS
  'One row per durable byte object, global across projects and runs: the SHA-256 is the identity, the size is fixed for it, and the bytes live in the blob store under the provider-generated key. The bytes themselves are never stored here.';
COMMENT ON COLUMN qe_blobs.size_bytes IS
  'The one size the hash has: every declaration and every object for it must agree.';
COMMENT ON COLUMN qe_blobs.storage_key IS
  'The relative key the blob provider published the object under. Recorded for operators; readers address blobs by hash, and the check only keeps it relative and free of dot segments.';
COMMENT ON COLUMN qe_blobs.stored_at IS
  'When this catalog row was written, which may be after the object was published (an unreferenced object reused by a later ingestion).';

CREATE TABLE qe_run_blobs (
  project_id  text  NOT NULL,
  run_id      text  NOT NULL,
  sha256      text  NOT NULL,
  CONSTRAINT qe_run_blobs_pkey PRIMARY KEY (project_id, run_id, sha256),
  CONSTRAINT qe_run_blobs_run_fkey FOREIGN KEY (project_id, run_id)
    REFERENCES qe_runs (project_id, run_id),
  CONSTRAINT qe_run_blobs_blob_fkey FOREIGN KEY (sha256) REFERENCES qe_blobs (sha256)
);

COMMENT ON TABLE qe_run_blobs IS
  'Which distinct durable byte objects an archived run requires: a rebuildable storage-integrity index derived from the run''s attachment events. Attachment names, media types, attempts, steps, and multiplicity come from the raw source lines only. A run archived before this table existed has no rows here until its bytes are materialised.';

CREATE INDEX qe_run_blobs_sha256_idx ON qe_run_blobs (sha256);

ALTER TABLE qe_runs RENAME COLUMN attachments_verified TO source_attachments_verified;

COMMENT ON COLUMN qe_runs.source_attachments_verified IS
  'The validation pass at ingestion checked the source attachment bytes against their declarations. An audit claim about the source at that moment, never proof that durable bytes exist: durable presence is qe_run_blobs plus qe_blobs, and integrity is established only by re-reading the blob store.';
`,
  },
  {
    version: 3,
    name: 'run-retention-and-cascades',
    sql: `
CREATE TABLE qe_run_retention (
  project_id  text        NOT NULL,
  run_id      text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  CONSTRAINT qe_run_retention_pkey PRIMARY KEY (project_id, run_id),
  CONSTRAINT qe_run_retention_run_fkey FOREIGN KEY (project_id, run_id)
    REFERENCES qe_runs (project_id, run_id) ON DELETE CASCADE
);

COMMENT ON TABLE qe_run_retention IS
  'The lifecycle fact of an archived run: when retention may delete it. A run with no row here was archived before retention existed and is retention-unmanaged: it is reported, never swept. Absence of a row is deliberate, so that no expiry is ever invented for data archived without one.';
COMMENT ON COLUMN qe_run_retention.project_id IS
  'The run''s project, as in qe_runs: retention is recorded per archived run, never per project.';
COMMENT ON COLUMN qe_run_retention.run_id IS
  'The run this expiry belongs to; the row goes when the run does.';
COMMENT ON COLUMN qe_run_retention.expires_at IS
  'Absolute instant supplied by whoever ingested the run, like the project id and never derived from its events, its files, or its ingestion time. Immutable once written: ordinary re-ingestion of the same run does not move it.';

CREATE INDEX qe_run_retention_expires_at_idx ON qe_run_retention (expires_at, project_id, run_id);

-- A run is deleted as a whole: its source, its blob relations, and its retention fact go with it.
-- qe_run_blobs is not cascaded into qe_blobs: a blob is global, and it is collected only after a
-- reference count across every project reaches zero.
-- Added NOT VALID and validated separately: the rows are already known to satisfy the same
-- reference, and this keeps the upgrade from holding the archive under an exclusive lock while
-- every existing row is re-checked.
ALTER TABLE qe_run_source_lines
  DROP CONSTRAINT qe_run_source_lines_run_fkey,
  ADD CONSTRAINT qe_run_source_lines_run_fkey FOREIGN KEY (project_id, run_id)
    REFERENCES qe_runs (project_id, run_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE qe_run_source_lines VALIDATE CONSTRAINT qe_run_source_lines_run_fkey;

ALTER TABLE qe_run_blobs
  DROP CONSTRAINT qe_run_blobs_run_fkey,
  ADD CONSTRAINT qe_run_blobs_run_fkey FOREIGN KEY (project_id, run_id)
    REFERENCES qe_runs (project_id, run_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE qe_run_blobs VALIDATE CONSTRAINT qe_run_blobs_run_fkey;
`,
  },
  {
    version: 4,
    name: 'query-indexes',
    sql: `
-- Everything below is derived: rebuildable from the raw source lines through the validator and
-- the projector, and never consulted as a semantic authority. The run archive stays the truth.
CREATE TABLE qe_run_query_index (
  project_id             text        COLLATE "C" NOT NULL,
  run_id                 text        COLLATE "C" NOT NULL,
  index_version          integer     NOT NULL,
  source_fingerprint     text        NOT NULL,
  verdict                text        NOT NULL,
  complete               boolean     NOT NULL,
  closed                 boolean     NOT NULL,
  ignored_event_count    integer     NOT NULL,
  duplicate_event_count  integer     NOT NULL,
  session_count          integer     NOT NULL,
  execution_count        integer     NOT NULL,
  scope_failure_count    integer     NOT NULL,
  attachment_count       integer     NOT NULL,
  indexed_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qe_run_query_index_pkey PRIMARY KEY (project_id, run_id),
  CONSTRAINT qe_run_query_index_project_id_check CHECK (project_id <> ''),
  CONSTRAINT qe_run_query_index_run_id_check CHECK (run_id <> ''),
  CONSTRAINT qe_run_query_index_verdict_check
    CHECK (verdict IN ('passed', 'failed', 'inconclusive', 'incomplete')),
  CONSTRAINT qe_run_query_index_run_fkey FOREIGN KEY (project_id, run_id)
    REFERENCES qe_runs (project_id, run_id) ON DELETE CASCADE,
  CONSTRAINT qe_run_query_index_version_check CHECK (index_version >= 1),
  CONSTRAINT qe_run_query_index_fingerprint_check CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT qe_run_query_index_counts_check CHECK (
    ignored_event_count >= 0 AND duplicate_event_count >= 0 AND session_count >= 0
    AND execution_count >= 0 AND scope_failure_count >= 0 AND attachment_count >= 0)
);

COMMENT ON TABLE qe_run_query_index IS
  'One row per run whose projection has been indexed for listing: rebuildable derived state, never truth. A run with no row here, or one whose index_version or source_fingerprint no longer match, is not indexed at all as far as a query is concerned.';
COMMENT ON COLUMN qe_run_query_index.index_version IS
  'How the projected run was read into these rows. Not the protocol version, not the schema version, not the package version: it changes when the interpretation does, and every row written under an older one must be rebuilt before it is served.';
COMMENT ON COLUMN qe_run_query_index.source_fingerprint IS
  'The content fingerprint of the archived source this index was derived from; a row whose fingerprint is not the run''s current one is stale.';
COMMENT ON COLUMN qe_run_query_index.verdict IS
  'Copied from the projected run, which copied it from the validator. Nothing here derives a verdict.';

-- What a run listing pages on: one project's runs, newest archived first.
CREATE INDEX qe_runs_project_sequence_idx ON qe_runs (project_id, ingestion_sequence);

-- Identifiers are printable ASCII (the protocol's own contract), so byte order is exactly the
-- code-unit order the in-memory history comparator uses. The collation is declared rather than
-- inherited so that the database's own ordering cannot drift from it.
CREATE TABLE qe_history_occurrences (
  project_id               text        COLLATE "C" NOT NULL,
  history_key              bytea       NOT NULL,
  index_version            integer     NOT NULL,
  run_id                   text        COLLATE "C" NOT NULL,
  execution_id             text        COLLATE "C" NOT NULL,
  runner_name              text        COLLATE "C" NOT NULL,
  historical_id            text        COLLATE "C" NOT NULL,
  historical_id_stability  text        NOT NULL,
  occurred_at_raw          text        NOT NULL,
  occurred_at_instant      timestamptz NOT NULL,
  occurred_at_leap         smallint    NOT NULL,
  session_ids              text[]      NOT NULL,
  attempt_count            integer     NOT NULL,
  complete                 boolean     NOT NULL,
  final_status             text,
  expected_status          text,
  flaky                    boolean     NOT NULL,
  run_verdict              text        NOT NULL,
  run_complete             boolean     NOT NULL,
  session_status           text,
  CONSTRAINT qe_history_occurrences_pkey PRIMARY KEY (project_id, run_id, execution_id),
  CONSTRAINT qe_history_occurrences_run_fkey FOREIGN KEY (project_id, run_id)
    REFERENCES qe_runs (project_id, run_id) ON DELETE CASCADE,
  CONSTRAINT qe_history_occurrences_attempts_check CHECK (attempt_count >= 1),
  CONSTRAINT qe_history_occurrences_project_id_check CHECK (project_id <> ''),
  CONSTRAINT qe_history_occurrences_ids_check
    CHECK (run_id <> '' AND execution_id <> '' AND runner_name <> '' AND historical_id <> ''),
  CONSTRAINT qe_history_occurrences_version_check CHECK (index_version >= 1),
  CONSTRAINT qe_history_occurrences_key_length_check CHECK (length(history_key) = 32),
  CONSTRAINT qe_history_occurrences_sessions_check
    CHECK (array_length(session_ids, 1) >= 1 AND array_position(session_ids, NULL) IS NULL),
  CONSTRAINT qe_history_occurrences_stability_check
    CHECK (historical_id_stability IN ('stable', 'uncertain', 'unavailable')),
  CONSTRAINT qe_history_occurrences_leap_check CHECK (occurred_at_leap BETWEEN 0 AND 1000),
  CONSTRAINT qe_history_occurrences_final_status_check
    CHECK (final_status IS NULL
           OR final_status IN ('passed', 'failed', 'skipped', 'inconclusive')),
  CONSTRAINT qe_history_occurrences_expected_status_check
    CHECK (expected_status IS NULL OR expected_status IN ('passed', 'failed', 'skipped')),
  CONSTRAINT qe_history_occurrences_run_verdict_check
    CHECK (run_verdict IN ('passed', 'failed', 'inconclusive', 'incomplete')),
  CONSTRAINT qe_history_occurrences_session_status_check
    CHECK (session_status IS NULL
           OR session_status IN ('passed', 'failed', 'inconclusive'))
);

COMMENT ON TABLE qe_history_occurrences IS
  'One row per execution that qualifies as history: it carries a historical id and its session declared a runner. Derived from the projected run, rebuildable, and never the place a flakiness or identity rule is decided. An execution without a historical id is absent rather than given one.';
COMMENT ON COLUMN qe_history_occurrences.history_key IS
  'SHA-256 of the runner name and the historical id, which is what the history index is keyed by. The names themselves are bounded by the protocol at 512 characters each, which in multi-byte text is more than a btree key can hold; a digest of fixed width can be, and the names are still compared exactly beside it so a collision could not answer the wrong question.';
COMMENT ON COLUMN qe_history_occurrences.occurred_at_instant IS
  'The history position of the first attempt''s producer timestamp, to the millisecond, from the read model''s own ordering primitive, so that ordering here and there cannot differ. For a leap second it is the last millisecond of the second before it, and occurred_at_leap says where inside the leap second it falls. The original string is kept beside it.';
COMMENT ON COLUMN qe_history_occurrences.occurred_at_leap IS
  '0 for an ordinary timestamp; for a leap second (23:59:60 UTC), 1 plus its millisecond within it. One timestamptz cannot hold a leap second apart from the second that follows it, so the position is the pair.';
COMMENT ON COLUMN qe_history_occurrences.flaky IS
  'Copied from the projected execution. SQL counts these; it never decides what flaky means.';

-- The one ordering a history page takes: the key, then the timestamp position (instant, then the
-- place inside a leap second), then the identifier tie-breakers.
CREATE INDEX qe_history_occurrences_key_idx ON qe_history_occurrences
  (project_id, history_key, occurred_at_instant, occurred_at_leap, run_id, execution_id)
  INCLUDE (index_version);

COMMENT ON COLUMN qe_history_occurrences.index_version IS
  'The interpretation this row was written under, carried beside the run''s own so that a query filters stale rows out structurally rather than trusting a check made a statement earlier.';
`,
  },
  {
    version: 5,
    name: 'transport-auth-and-project-id-bound',
    sql: `
-- The project id contract (well-formed Unicode, no U+0000, at most 512 bytes of UTF-8) is only
-- enforceable by a UTF-8 database: it is what rejects malformed text and U+0000 in the first place.
DO $$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'migration 5: the database encoding is %, and qe-report requires UTF8 so that a project id is well-formed Unicode', current_setting('server_encoding');
  END IF;
END
$$;

-- An archived project id beyond the bound is reported, never truncated, hashed, or renamed.
DO $$
DECLARE
  offending bigint;
BEGIN
  SELECT count(*) INTO offending FROM qe_runs WHERE octet_length(project_id) > 512;
  IF offending > 0 THEN
    RAISE EXCEPTION 'migration 5: % archived runs have a project id longer than 512 bytes of UTF-8', offending
      USING HINT = 'Reconcile those runs (re-archive them under a conforming project id, or delete them) and run the migration again; nothing was changed.';
  END IF;
END
$$;

-- The canonical archive is the storage authority for the bound: every derived and relation table
-- references a run by this key.
ALTER TABLE qe_runs
  ADD CONSTRAINT qe_runs_project_id_bound_check CHECK (octet_length(project_id) <= 512);

-- Project-scoped machine credentials. A key is found by its public id and proven by a secret
-- whose SHA-256 alone is stored; nothing here can give the secret back. No project table exists:
-- a key may be issued for a project that holds no run yet.
CREATE TABLE qe_project_api_keys (
  public_id      text        COLLATE "C" NOT NULL,
  project_id     text        NOT NULL,
  secret_sha256  bytea       NOT NULL,
  scopes         text[]      NOT NULL,
  label          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  revoked_at     timestamptz,
  CONSTRAINT qe_project_api_keys_pkey PRIMARY KEY (public_id),
  CONSTRAINT qe_project_api_keys_public_id_check CHECK (public_id ~ '^[a-z2-7]{16}$'),
  CONSTRAINT qe_project_api_keys_project_id_check
    CHECK (project_id <> '' AND octet_length(project_id) <= 512),
  CONSTRAINT qe_project_api_keys_secret_check CHECK (length(secret_sha256) = 32),
  CONSTRAINT qe_project_api_keys_scopes_check CHECK (
    scopes = ARRAY['runs:read']::text[]
    OR scopes = ARRAY['runs:write']::text[]
    OR scopes = ARRAY['runs:read', 'runs:write']::text[]),
  CONSTRAINT qe_project_api_keys_label_check
    CHECK (label IS NULL OR (label <> '' AND char_length(label) <= 200)),
  CONSTRAINT qe_project_api_keys_revoked_check
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

COMMENT ON TABLE qe_project_api_keys IS
  'Project-scoped machine credentials. The credential alone determines the project a request acts on; no request names one. Issued and revoked by an operator, never over HTTP.';
COMMENT ON COLUMN qe_project_api_keys.public_id IS
  'The lookup handle carried in the token: 80 random bits, lower-case base32. Not a secret.';
COMMENT ON COLUMN qe_project_api_keys.secret_sha256 IS
  'SHA-256 of the 256 random bits of secret. The secret itself, the token, and any header carrying it are never stored.';
COMMENT ON COLUMN qe_project_api_keys.scopes IS
  'runs:read, runs:write, or both, in that order. There is no other scope, no wildcard, and no administrative scope.';

-- What a key is for never changes: another project or other scopes are another key.
CREATE FUNCTION qe_project_api_keys_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.public_id IS DISTINCT FROM OLD.public_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.secret_sha256 IS DISTINCT FROM OLD.secret_sha256
     OR NEW.scopes IS DISTINCT FROM OLD.scopes
     OR NEW.label IS DISTINCT FROM OLD.label
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'an API key is immutable except for being revoked, once';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER qe_project_api_keys_immutable_trigger
  BEFORE UPDATE ON qe_project_api_keys
  FOR EACH ROW EXECUTE FUNCTION qe_project_api_keys_immutable();
`,
  },
];
