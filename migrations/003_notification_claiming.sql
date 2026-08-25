-- The dispatcher has to claim a job before doing the HTTP call, because the
-- call happens outside any transaction: holding one open across a network
-- request with increasing waits would block everything touching that task.
--
-- 'sending' marks a job somebody is working on, and claimed_at lets a stale
-- claim be recovered if the process dies mid-flight. Without both, a crash
-- between claiming and finishing would strand the notification forever.
ALTER TABLE notification_jobs
  MODIFY state ENUM('pending','sending','succeeded','exhausted') NOT NULL DEFAULT 'pending',
  ADD COLUMN claimed_at TIMESTAMP NULL AFTER next_attempt_at;
