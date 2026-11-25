CREATE TABLE operation_receipts (
  actor_id text NOT NULL,
  operation_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, operation_key)
);
