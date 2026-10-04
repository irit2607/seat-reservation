CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  -- SHA-256 of show id + sorted seats, to detect the same key sent with a different body.
  request_hash TEXT NOT NULL,
  -- Exactly one outcome: the reservation it created, or the decline it got.
  -- Deferred, because the key is claimed before the reservation row is inserted
  -- in the same transaction; the reference is checked at COMMIT.
  reservation_id UUID REFERENCES reservations(id) DEFERRABLE INITIALLY DEFERRED,
  response_status INT,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key),
  CONSTRAINT idempotency_keys_one_outcome CHECK ((reservation_id IS NULL) <> (response_status IS NULL))
);
