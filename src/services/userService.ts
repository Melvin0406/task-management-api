import { isDuplicateKeyError, withTransaction } from '../db/pool';
import { errors } from '../http/errors';
import { findUserById, insertUser, type UserRow } from '../repositories/userRepository';
import type { CreateUserInput } from '../validation/schemas';

export async function createUser(input: CreateUserInput): Promise<UserRow> {
  return withTransaction(async (conn) => {
    let id: number;
    try {
      id = await insertUser(conn, input);
    } catch (error) {
      // The brief does not say what to do about a repeated email. Rather than
      // checking first and losing the race between the check and the insert,
      // the unique index decides and the conflict is translated here.
      if (isDuplicateKeyError(error)) {
        throw errors.emailAlreadyExists(input.email);
      }
      throw error;
    }

    const user = await findUserById(conn, id);
    if (!user) {
      throw new Error(`User ${id} vanished right after being inserted`);
    }
    return user;
  });
}
