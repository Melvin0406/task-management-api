import { errors } from './errors';

/**
 * A path segment that is not a positive integer is malformed input, so it is a
 * 400 rather than a 404: the resource is not missing, the request never named
 * one. Documented as an assumption in the README.
 */
export function parseIdParam(raw: string, what: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw errors.validation(`${what} must be a positive integer`);
  }
  return id;
}
