-- 001_init.sql — initial schema.
--
-- Three constraints in here are load-bearing, not decoration. They are what
-- make the reliability guarantees hold under concurrency, instead of relying
-- on application-level checks that lose every race:
--
--   * task_assignments PRIMARY KEY (task_id, user_id)
--       Makes a duplicated assignment impossible at the storage layer.
--   * notification_jobs UNIQUE (task_id)
--       A task can never have two notification jobs, so "notify exactly once"
--       survives retries, crashes and concurrent completions.
--   * idempotency_keys UNIQUE (idem_key)
--       Acts as the mutex for the whole idempotency mechanism: the losing
--       INSERT blocks until the winner commits, then reads its stored response.

CREATE TABLE users (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120)    NOT NULL,
  last_name   VARCHAR(120)    NOT NULL,
  email       VARCHAR(255)    NOT NULL,
  created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE tasks (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title        VARCHAR(200)    NOT NULL,
  description  TEXT            NULL,
  status       ENUM('open','archived') NOT NULL DEFAULT 'open',
  archived_at  TIMESTAMP       NULL,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tasks_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE task_assignments (
  task_id       BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  assigned_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at  TIMESTAMP       NULL,
  PRIMARY KEY (task_id, user_id),
  KEY idx_assignments_user (user_id),
  CONSTRAINT fk_assignments_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
  CONSTRAINT fk_assignments_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Transactional outbox. A row is inserted in the same transaction that archives
-- the task, so either both happen or neither does. The dispatcher picks it up
-- afterwards, outside any transaction, because the HTTP call must never be held
-- inside one.
CREATE TABLE notification_jobs (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id          BIGINT UNSIGNED NOT NULL,
  state            ENUM('pending','succeeded','exhausted') NOT NULL DEFAULT 'pending',
  attempts_made    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload          JSON            NOT NULL,
  created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_notification_jobs_task (task_id),
  KEY idx_jobs_due (state, next_attempt_at),
  CONSTRAINT fk_jobs_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per delivery attempt. This is what GET /tasks/:idTask/notifications
-- returns. http_status is NULL when the destination did not answer at all.
CREATE TABLE notification_attempts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  task_id         BIGINT UNSIGNED NOT NULL,
  attempt_number  TINYINT UNSIGNED NOT NULL,
  attempted_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  http_status     SMALLINT        NULL,
  outcome         ENUM('success','http_error','no_response') NOT NULL,
  error_message   VARCHAR(500)    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_attempt_number (task_id, attempt_number),
  CONSTRAINT fk_attempts_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- request_hash is the sha256 of the canonicalised request body. Same key with a
-- different body is a client bug, and is rejected instead of silently replaying
-- someone else's response.
CREATE TABLE idempotency_keys (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  idem_key         VARCHAR(255)  NOT NULL,
  endpoint         VARCHAR(120)  NOT NULL,
  request_hash     CHAR(64)      NOT NULL,
  response_status  SMALLINT      NOT NULL,
  response_body    JSON          NOT NULL,
  created_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_idempotency_key (idem_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
