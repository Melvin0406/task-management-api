import { z } from 'zod';

/**
 * All request-body validation lives here so that every 400 in the API has a
 * single origin. `.strict()` is deliberate: an unexpected field usually means
 * the client is calling the wrong endpoint or a field was renamed, and failing
 * loudly beats silently ignoring it.
 */

export const createUserSchema = z
  .object({
    name: z.string().trim().min(1, 'is required').max(120),
    lastName: z.string().trim().min(1, 'is required').max(120),
    email: z.string().trim().email('must be a valid email address').max(255),
  })
  .strict();

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(1, 'is required').max(200),
    // Optional per the brief. null is accepted so clients can send it explicitly.
    description: z.string().trim().max(65_535).nullish(),
  })
  .strict();

const positiveId = z.number().int().positive();

export const assignUsersSchema = z
  .object({
    // Deduplicated here so [1, 1, 2] is not treated as a client error: the
    // request is unambiguous, and the intent is that those users end up
    // assigned.
    userIds: z
      .array(positiveId)
      .min(1, 'must contain at least one user id')
      .transform((ids) => [...new Set(ids)]),
  })
  .strict();

export const completeTaskSchema = z.object({ userId: positiveId }).strict();

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type AssignUsersInput = z.infer<typeof assignUsersSchema>;
export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/**
 * `?status` accepts only the two documented values. An unrecognised one is a
 * 400 rather than an empty list: silently returning nothing would look like
 * "there are no tasks" when the real answer is "that filter is not a thing".
 */
export const taskStatusQuerySchema = z
  .enum(['open', 'archived'], {
    errorMap: () => ({ message: 'must be either open or archived' }),
  })
  .optional();
