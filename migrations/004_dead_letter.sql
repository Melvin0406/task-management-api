-- Supports the dead-letter improvement: a job that exhausted its attempts can
-- be re-queued by an operator, which starts a fresh cycle of attempts.
--
-- attempts_made counts attempts within the current cycle, so a manual retry
-- resets it. notification_attempts.attempt_number, by contrast, keeps counting
-- upwards forever, so the delivery log stays complete and ordered across
-- cycles instead of colliding with the previous one.
ALTER TABLE notification_jobs
  ADD COLUMN manual_retries INT UNSIGNED NOT NULL DEFAULT 0 AFTER attempts_made;
