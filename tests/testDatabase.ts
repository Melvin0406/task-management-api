/**
 * Single source of truth for the test database name.
 *
 * It has to be shared: vitest.config.ts puts it in the test environment, but
 * globalSetup runs in a different context that does not inherit it, so relying
 * on the env var in both places silently migrates the development database
 * instead.
 */
export const TEST_DATABASE = 'taskapi_test';
