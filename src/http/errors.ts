/**
 * Every error that reaches the client is an AppError, so that the response
 * envelope required by the brief is produced in exactly one place:
 *
 *   { "error": { "code": "...", "message": "..." } }
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  validation: (message: string) => new AppError('VALIDATION_ERROR', 400, message),

  routeNotFound: (method: string, url: string) =>
    new AppError('ROUTE_NOT_FOUND', 404, `No route matches ${method} ${url}`),

  userNotFound: (id: number | string) =>
    new AppError('USER_NOT_FOUND', 404, `User ${id} does not exist`),

  usersNotFound: (ids: number[]) =>
    new AppError(
      'USER_NOT_FOUND',
      404,
      ids.length === 1
        ? `User ${ids[0]} does not exist`
        : `These users do not exist: ${ids.join(', ')}`,
    ),

  taskNotFound: (id: number | string) =>
    new AppError('TASK_NOT_FOUND', 404, `Task ${id} does not exist`),

  userNotAssigned: (userId: number | string, taskId: number | string) =>
    new AppError('USER_NOT_ASSIGNED', 409, `User ${userId} is not assigned to task ${taskId}`),

  taskAlreadyArchived: (id: number | string) =>
    new AppError('TASK_ALREADY_ARCHIVED', 409, `Task ${id} is already archived`),

  emailAlreadyExists: (email: string) =>
    new AppError('EMAIL_ALREADY_EXISTS', 409, `A user with email ${email} already exists`),

  /**
   * Same Idempotency-Key, different endpoint or different body. Replaying the
   * stored response would be wrong, so this is rejected instead.
   */
  idempotencyKeyReused: () =>
    new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      409,
      'This Idempotency-Key was already used for a different request',
    ),
};
