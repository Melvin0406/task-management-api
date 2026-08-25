# Modelo de datos

Diagrama entidad-relación con tipos y relaciones. El esquema versionado que lo produce está en
[`../migrations/`](../migrations/).

```mermaid
erDiagram
    users {
        bigint id PK
        varchar_120 name
        varchar_120 last_name
        varchar_255 email UK
        timestamp created_at
    }
    tasks {
        bigint id PK
        varchar_200 title
        text description "NULL"
        enum status "open o archived"
        timestamp archived_at "NULL"
        timestamp created_at
    }
    task_assignments {
        bigint task_id PK "y FK"
        bigint user_id PK "y FK"
        timestamp assigned_at
        timestamp completed_at "NULL"
    }
    notification_jobs {
        bigint id PK
        bigint task_id FK "UNIQUE"
        enum state "pending sending succeeded exhausted"
        tinyint attempts_made
        int manual_retries
        timestamp next_attempt_at
        timestamp claimed_at "NULL"
        json payload
    }
    notification_attempts {
        bigint id PK
        bigint task_id FK
        tinyint attempt_number "UNIQUE con task_id"
        timestamp attempted_at
        smallint http_status "NULL si no hubo respuesta"
        enum outcome "success http_error no_response"
        varchar_500 error_message "NULL"
    }
    idempotency_keys {
        bigint id PK
        varchar_255 idem_key UK
        varchar_120 endpoint
        char_64 request_hash
        smallint response_status
        longtext response_body
    }
    users ||--o{ task_assignments : "es asignado a"
    tasks ||--o{ task_assignments : "tiene asignados"
    tasks ||--o| notification_jobs : "genera"
    tasks ||--o{ notification_attempts : "registra"
```

## Las restricciones que cargan peso

Tres restricciones cargan peso: la PK compuesta de `task_assignments` hace imposible duplicar una
asignación, el `UNIQUE` de `notification_jobs.task_id` sostiene "notificar exactamente una vez", y el
`UNIQUE` de `idem_key` es el mutex de toda la idempotencia.

Con detalle:

| Restricción | Qué garantiza |
|---|---|
| `task_assignments` PK `(task_id, user_id)` | Imposible duplicar una asignación, aunque lleguen dos peticiones idénticas a la vez. No hace falta comprobarlo en código. |
| `notification_jobs` UNIQUE `(task_id)` | Una tarea no puede tener dos trabajos de notificación, así que "notificar exactamente una vez" sobrevive a caídas y a completaciones concurrentes. |
| `notification_attempts` UNIQUE `(task_id, attempt_number)` | Imposible registrar dos veces el intento N. Por eso el número de intento es monótono entre ciclos de reenvío, en vez de reiniciarse. |
| `idempotency_keys` UNIQUE `(idem_key)` | El mutex de toda la idempotencia: el `INSERT` perdedor espera al ganador en vez de fallar de inmediato. |
| `users` UNIQUE `(email)` | Decide el email repetido sin una consulta previa que perdería la carrera. |
