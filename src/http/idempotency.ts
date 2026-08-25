import type { Request } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { isDuplicateKeyError, withTransaction } from '../db/pool';
import {
  claimIdempotencyKey,
  findStoredResponse,
  hashRequestBody,
  saveIdempotentResponse,
} from '../repositories/idempotencyRepository';
import { errors } from './errors';

export interface Outcome<T> {
  status: number;
  body: T;
}

/**
 * What the route actually writes. `raw` is the serialised body rather than the
 * object, because both paths -- doing the work and replaying a stored response
 * -- have to emit the same bytes for the brief's "both responses must be
 * identical" to hold literally and not just semantically.
 */
export interface Rendered {
  status: number;
  raw: string;
}

/** Raised only when the *idempotency* insert conflicts, never when the business
 *  work happens to hit some other unique index. */
class KeyAlreadyClaimed extends Error {}

/**
 * Runs a write endpoint at most once per Idempotency-Key.
 *
 * The header is optional, as the brief specifies: it says POST endpoints must
 * *accept* the header, not require it, and the Funcionalidad basica section
 * enumerates each endpoint's expected errors without a missing header among
 * them. Requiring it would make a plain `curl -X POST /users` fail, which is
 * exactly what gets run against the public URL.
 *
 * Without a key the work still runs in a transaction, just unprotected. Note
 * that three of the four POST endpoints are already idempotent by domain design
 * anyway; only POST /tasks genuinely creates something new on every call.
 */
export async function runIdempotent<T>(
  req: Request,
  endpoint: string,
  work: (conn: PoolConnection) => Promise<Outcome<T>>,
): Promise<Rendered> {
  const key = req.header('Idempotency-Key');
  if (!key) {
    const outcome = await withTransaction(work);
    return { status: outcome.status, raw: JSON.stringify(outcome.body) };
  }

  const requestHash = hashRequestBody(req.body);

  try {
    return await withTransaction(async (conn) => {
      try {
        await claimIdempotencyKey(conn, key, endpoint, requestHash);
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new KeyAlreadyClaimed();
        throw error;
      }

      const outcome = await work(conn);
      const raw = JSON.stringify(outcome.body);
      // Stored in the same transaction as the work, so a stored response can
      // never describe something that did not happen.
      await saveIdempotentResponse(conn, key, outcome.status, raw);
      return { status: outcome.status, raw };
    });
  } catch (error) {
    if (!(error instanceof KeyAlreadyClaimed)) throw error;
    // Falls through: someone else owns this key.
  }

  // By the time we get here the winner has committed, because our INSERT waited
  // on its index lock rather than failing straight away. So the stored response
  // is already visible.
  const stored = await withTransaction((conn) => findStoredResponse(conn, key));
  if (!stored) throw errors.idempotencyKeyReused();

  // Same key, different request. Replaying a response that does not belong to
  // this call would be worse than refusing.
  if (stored.endpoint !== endpoint || stored.requestHash !== requestHash) {
    throw errors.idempotencyKeyReused();
  }

  return { status: stored.responseStatus, raw: stored.responseBody };
}
