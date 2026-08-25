-- The replayed response must be identical to the first one, not merely
-- equivalent. Stored in a JSON column, MySQL normalises key order, so a replay
-- came back with the same values in a different order. Storing the exact bytes
-- that were sent the first time makes the replay byte-for-byte identical.
ALTER TABLE idempotency_keys
  MODIFY response_body LONGTEXT NOT NULL;
