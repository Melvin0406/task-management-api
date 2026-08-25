import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

export interface StoredResponse {
  endpoint: string;
  requestHash: string;
  responseStatus: number;
  /** The exact bytes sent the first time, so a replay is byte-identical. */
  responseBody: string;
}

/**
 * Canonical hash of the request body.
 *
 * Object keys are sorted so that two bodies that differ only in key order count
 * as the same request: a client retrying is not required to serialise its JSON
 * identically.
 */
export function hashRequestBody(body: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical(body) ?? null)).digest('hex');
}

/**
 * Claims the key for this request.
 *
 * This is the mutex. It does not check whether the key exists first, because
 * checking loses the race the brief explicitly requires us to win: two parallel
 * requests would both pass the check before either inserts.
 *
 * Instead the unique index decides. While the winner's transaction is open,
 * InnoDB holds a lock on its index entry, so a second INSERT of the same key
 * *waits* rather than failing immediately. It wakes up when the winner commits
 * (and then gets a duplicate-key error, with the response already stored and
 * visible) or when the winner rolls back (and then succeeds, taking over the
 * work).
 *
 * Throws the driver's ER_DUP_ENTRY when the key is already taken; the caller
 * translates that into replaying the stored response.
 */
export async function claimIdempotencyKey(
  conn: PoolConnection,
  key: string,
  endpoint: string,
  requestHash: string,
): Promise<void> {
  await conn.execute(
    `INSERT INTO idempotency_keys (idem_key, endpoint, request_hash, response_status, response_body)
     VALUES (?, ?, ?, 0, '')`,
    [key, endpoint, requestHash],
  );
}

/** Stores the outcome, in the same transaction that produced it. */
export async function saveIdempotentResponse(
  conn: PoolConnection,
  key: string,
  status: number,
  serialisedBody: string,
): Promise<void> {
  await conn.execute(
    `UPDATE idempotency_keys
        SET response_status = ?, response_body = ?
      WHERE idem_key = ?`,
    [status, serialisedBody, key],
  );
}

export async function findStoredResponse(
  conn: PoolConnection,
  key: string,
): Promise<StoredResponse | null> {
  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT endpoint, request_hash AS requestHash,
            response_status AS responseStatus, response_body AS responseBody
       FROM idempotency_keys
      WHERE idem_key = ?`,
    [key],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    endpoint: row.endpoint as string,
    requestHash: row.requestHash as string,
    responseStatus: Number(row.responseStatus),
    responseBody: row.responseBody as string,
  };
}
