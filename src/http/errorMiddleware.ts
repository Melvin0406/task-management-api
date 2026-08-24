import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, errors } from './errors';

/**
 * Catches requests that matched no route. Without this, Express answers with
 * its own HTML 404 and the brief's requirement that *all* errors use the same
 * envelope would quietly not hold.
 */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(errors.routeNotFound(req.method, req.originalUrl));
};

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.join('.');
      return field ? `${field}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.httpStatus).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }

  if (error instanceof ZodError) {
    const appError = errors.validation(formatZodError(error));
    res.status(appError.httpStatus).json({
      error: { code: appError.code, message: appError.message },
    });
    return;
  }

  // Malformed JSON body: express.json() throws a SyntaxError with `body` set.
  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
    });
    return;
  }

  // Anything reaching here is a bug. Log it in full, but never leak internals
  // to the client.
  console.error(error);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
};
