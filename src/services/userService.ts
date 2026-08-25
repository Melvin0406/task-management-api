import type { PoolConnection } from 'mysql2/promise';
import { isDuplicateKeyError } from '../db/pool';
import { errors } from '../http/errors';
import { findUserById, insertUser, type UserRow } from '../repositories/userRepository';
import type { CreateUserInput } from '../validation/schemas';

/**
 * Every service takes the connection instead of opening its own transaction.
 * The transaction is owned by `runIdempotent`, so that the business work and
 * the idempotency bookkeeping commit or roll back together.
 */
export async function createUser(
  conn: PoolConnection,
  input: CreateUserInput,
): Promise<UserRow> {
  let id: number;
  try {
    id = await insertUser(conn, input);
  } catch (error) {
    // The brief does not cover a repeated email. Rather than checking first and
    // losing the race between the check and the insert, the unique index
    // decides and the conflict is translated here.
    if (isDuplicateKeyError(error)) {
      throw errors.emailAlreadyExists(input.email);
    }
    throw error;
  }

  const user = await findUserById(conn, id);
  if (!user) throw new Error(`User ${id} vanished right after being inserted`);
  return user;
}
