# Decisiones y supuestos

Registro en crudo de cada decisión conforme se toma. **Es la materia prima del README**, que tiene
límite de 2 páginas y por lo tanto no puede contener todo esto.

Regla del proyecto: **nada se queda en el repo si no lo puedo explicar en voz alta.** El enunciado
avisa que hay que defender cada decisión como propia.

---

## Decisiones de stack

| Decisión | Elección | Razón |
|---|---|---|
| Lenguaje | Node.js + TypeScript | Es mi stack de trabajo del último año, y el enunciado lo pide. |
| Framework HTTP | Express | Es el que usé en producción. Elegir algo más moderno sería una decisión que no puedo defender como propia. |
| Base de datos | MySQL 8.4 | **Es la única opción donde la concurrencia del reto es real.** SQLite serializa las escrituras, así que los requisitos de idempotencia y archivado se cumplirían por accidente del motor y no por diseño. |
| Acceso a datos | `mysql2/promise` con SQL a mano | El reto se juega en semántica exacta de SQL: filas afectadas, conflicto de índice único, `FOR UPDATE`. Con un ORM estaría defendiendo las decisiones de transacción del ORM y no las mías. |
| Migraciones | `.sql` numerados + script propio | Cumple "esquema versionado en el repositorio" y deja el SQL legible para quien evalúe. Un framework generaría migraciones que nadie puede leer de un vistazo. |
| Validación | zod | Un solo lugar del que salen todos los 400. |
| Tests | Vitest + supertest | Vitest es el único framework de tests con el que he trabajado antes. |
| Idioma | Código en inglés, README en español | Inglés es el default de la industria y mantiene el repo útil como portafolio; el README va en español porque es el idioma de este proceso. |

## El candado de `complete`, y por qué está probado y no supuesto

`POST /tasks/:id/complete` toma un `SELECT ... FOR UPDATE` sobre la tarea en su primer statement.
La justificación **no** es la que parece. El riesgo obvio es archivar dos veces; el riesgo real es
**no archivar nunca**.

Bajo `REPEATABLE READ`, que es el default de MySQL, dos transacciones concurrentes leen cada una un
snapshot tomado antes de que la otra hiciera commit. Las dos cuentan una parte pendiente, las dos
deciden no archivar, y la tarea se queda abierta para siempre con todo terminado. Es un bug
silencioso: nadie recibe un error.

**Comprobado quitando el `FOR UPDATE` y volviendo a correr la carrera:**

| | Rondas correctas |
|---|---|
| Con `FOR UPDATE` | **15 de 15** |
| Sin `FOR UPDATE` | **0 de 15** — `archivedNow=0`, las dos respuestas con estado `open` |

Falla en la dirección predicha: la tarea **nunca** se archiva.

**Y un aviso sobre cómo medirlo**, porque el primer intento de prueba dio un falso positivo. Lanzar
las dos peticiones con dos `curl` en segundo plano **no** provoca la carrera: arrancar cada proceso
tarda más que la transacción entera, así que nunca se solapan y la versión sin candado también
pasaba. Hay que dispararlas desde el mismo proceso con `Promise.all`. Un test de concurrencia que no
solapa de verdad no prueba nada, y se ve idéntico a uno que sí.

## La respuesta reproducida se guarda como bytes, no como JSON

El enunciado pide que las dos respuestas sean **idénticas**. Guardando la respuesta en una columna
`JSON`, **MySQL normaliza el orden de las llaves**, así que la reproducida volvía con los mismos
valores en otro orden: equivalente, pero no idéntica.

Se cambió `response_body` a `LONGTEXT` (migración `002`) y se guardan **los bytes exactos que se
enviaron la primera vez**. Por eso `runIdempotent` devuelve el cuerpo ya serializado y no el objeto:
así los dos caminos —hacer el trabajo y reproducir— emiten la misma cadena por construcción, no por
coincidencia.

## Los errores no se memorizan

Si el trabajo falla, la transacción se revierte y **la fila de la llave se revierte con ella**, así
que la llave queda libre. Un `POST` que falló con 404 se puede reintentar con la misma llave.

Es un supuesto: Stripe sí guarda las respuestas de error. Se eligió lo contrario porque el enunciado
sólo exige que una operación repetida **se ejecute una sola vez**, y liberar la llave ante un fallo
es más útil para el cliente que congelarle un error.

## El despachador de notificaciones

**La llamada HTTP nunca ocurre dentro de una transacción.** Con esperas crecientes hasta 3 intentos,
la entrega puede tardar decenas de segundos: sostener una transacción ese tiempo bloquearía todo lo
que toque esa tarea, y quien hizo `POST /complete` no puede esperar a que termine. Por eso la
transacción que archiva **sólo encola** una fila en `notification_jobs`, y un despachador aparte la
recoge.

**Cómo se reclama un trabajo.** Un `UPDATE ... SET state='sending' WHERE id=? AND state='pending'`:
por muchos despachadores que compitan, sólo uno ve `affectedRows = 1`, y sólo ése hace la llamada.
Es la razón por la que correr **más de una instancia de la API no duplicaría el envío**.

**Si el proceso muere a media entrega**, el trabajo queda en `sending`. Un barrido devuelve a
`pending` las reclamaciones más viejas que el timeout más un margen, **sin contar el intento**: no se
sabe si la petición llegó al destino, y el presupuesto de tres intentos no debería gastarse en una
caída.

**Política de reintentos:**

| Resultado | Se reintenta |
|---|---|
| 2xx | No: éxito. |
| 5xx | **Sí**, textual del enunciado. |
| Sin respuesta o timeout | **Sí**, textual del enunciado. |
| 4xx | **No.** El destino entendió y rechazó; la misma petición va a ser rechazada las tres veces. Es un supuesto y va al README. |

**El timeout por intento no es opcional.** Sin él, un destino que acepta la conexión y nunca contesta
dejaría la petición colgada para siempre, "sin respuesta" nunca ocurriría, y la política de
reintentos jamás correría.

Esperas: 1 s, 4 s, 16 s.

## Decisiones de arquitectura

- **Capas `routes → controllers → services → repositories`.** Es la estructura que operé en
  producción. Las transacciones viven en la capa de servicio, nunca en los controladores.
- **`createApp()` como factory** en vez de una app a nivel de módulo, para que los tests de
  integración monten la app con supertest sin abrir un puerto.
- **`withTransaction()` es el único camino de escritura.** Las garantías de concurrencia dependen de
  candados de fila y de conflictos de índice único, y ésos sólo significan algo si los statements
  comparten una conexión y una transacción. Usar `pool.query` suelto reparte una conexión distinta
  por statement y los rompe en silencio.

## Supuestos ante ambigüedades del enunciado

*(Se llenan conforme se implementan los endpoints. Todos van al README.)*

- **`Idempotency-Key` es opcional, no obligatorio.** El enunciado dice que los POST *deben aceptar*
  el header, no que lo exijan, y la sección de Funcionalidad básica enumera los errores esperados de
  cada endpoint sin incluir "falta el header". Exigirlo haría fallar un `POST /users` sin headers,
  que es exactamente lo que se va a probar contra la URL pública.
- **El alcance de la llave es global**, no por endpoint: `UNIQUE (idem_key)`. Es la opción más
  estricta de las dos. Si un cliente reusa la misma llave en otra ruta, recibe 409 en vez de que
  pase en silencio.
- **Misma llave con body distinto → 409 `IDEMPOTENCY_KEY_REUSED`**, en vez de reproducir una
  respuesta que no corresponde. Para eso se guarda `request_hash`.
- **Email repetido en `POST /users` → 409 `EMAIL_ALREADY_EXISTS`.** El enunciado no lo menciona.
  Se resuelve dejando que decida el índice único y traduciendo el conflicto, en vez de consultar
  antes: consultar primero pierde la carrera entre la consulta y el insert.
- **Un campo no reconocido en el body es 400**, no se ignora. Un campo de más suele significar que
  el cliente está llamando al endpoint equivocado o que algo se renombró, y fallar ruidosamente
  cuesta menos que ignorarlo en silencio.
- **`description` ausente y `description: null` se guardan igual.** El enunciado la marca opcional.
- **Los strings se recortan antes de validar**, así que un título de puros espacios es 400 y no una
  tarea con título en blanco.
- **Un id de ruta no numérico es 400, no 404.** El recurso no falta: la petición nunca nombró uno.
- **`assign` sobre una tarea archivada → 409 `TASK_ALREADY_ARCHIVED`.** Asignar a alguien una tarea
  ya cerrada dejaría la tarea archivada con una parte que nadie hizo, o sea un estado incoherente.
- **`assign` valida los usuarios como conjunto** y nombra todos los inexistentes de una vez, en vez
  de obligar al cliente a descubrirlos de uno en uno.
- **`userIds` se deduplica.** `[1, 1, 2]` no es un error del cliente: la intención es inequívoca.
- **Repetir `complete` es éxito, no error.** Y eso cubre también el reintento que llega cuando la
  tarea ya se archivó: una tarea archivada es, por definición, una donde todas las partes están
  hechas. Sin esto, el reintento del último usuario recibiría un 409 por hacer algo que ya logró.


## Notas de implementación pendientes

- [ ] **`NOTIFY_URL` en el servidor es un placeholder.** Hay que ponerle una URL real de
      `webhook.site` antes de entregar, o la notificación de F4 no tendrá a dónde llegar en la demo.
- [x] ~~Archivado exactamente una vez~~ (F2, con contraprueba).
- [x] ~~Idempotencia por `Idempotency-Key`~~ (F3).
- [x] ~~Notificaciones con reintentos~~ (F4).
- [ ] Decidir la mejora adicional al final, no antes.
- [ ] Diagrama Mermaid del modelo de datos.

---

## Bitácora

- **2026-08-24 — F0.** Andamio: TypeScript, Express, Docker Compose con MySQL 8.4, migraciones con
  el esquema completo, sobre de error único, `/health` y esqueleto del README. Sin endpoints de
  negocio todavía.

- **2026-08-24 — F1, parte 1.** Artefactos de despliegue (Dockerfile multi-etapa, compose de
  producción, bootstrap del servidor) y los dos POST de creación, con sus repositorios, servicios y
  validación. Nginx y certbot van en el host y no en compose, porque certbot instala su propio timer
  de renovación y el requisito es que la URL siga viva 7 días sin supervisión.

  **F1 cerrada:** desplegada en <https://167-99-2-144.sslip.io> con TLS de Let's Encrypt.

  El acceso costó un rodeo que vale la pena anotar: la llave del droplet no fallaba por ser la
  equivocada, sino porque **`id_ed25519` tiene passphrase** y sin agente SSH no se puede abrir de
  forma no interactiva. Se resolvió con una llave dedicada y sin passphrase, acotada a este droplet
  desechable, en vez de quitarle la passphrase a la llave personal.

  Medido en el servidor: 569 MB usados de 961, MySQL en 215 MB con `performance-schema` apagado.
  Eso confirma que la caja de 512 MB no alcanzaba. Tras un `reboot` la pila vuelve sola en ~40 s con
  los datos intactos, y `certbot renew --dry-run` pasa.

- **2026-08-24 — F2.** `assign` y `complete`, con el candado sobre la tarea y el archivado
  exactamente una vez. Ambos endpoints toman el mismo candado: sin él en `assign`, asignar a alguien
  podría entrelazarse con la última completación y dejar la tarea archivada con una parte pendiente.

  La zona horaria del driver quedó fijada en `Z` en vez del default `local`, porque el payload de la
  notificación lleva timestamp ISO terminado en Z y dejarlo implícito hace que cada timestamp
  dependa de la máquina que corra el proceso.

- **2026-08-25 — F3.** Idempotencia. El índice único sobre `idem_key` hace de mutex: no se consulta
  antes de insertar, porque consultar pierde justo la carrera que el enunciado exige ganar.

  Los servicios se refactorizaron para recibir la conexión en vez de abrir su propia transacción, de
  modo que el trabajo de negocio y el registro de la llave hagan commit o rollback juntos.

  **Verificado:** misma llave en paralelo, 12 de 12 rondas con respuestas byte a byte idénticas y 12
  tareas creadas de 24 peticiones. Más: misma llave secuencial, cuerpo distinto → 409, otro endpoint
  → 409, sin header → dos tareas distintas, y misma llave en `/complete` en paralelo → una sola
  notificación encolada.

- **2026-08-25 — F4.** Outbox, despachador, reintentos y `GET /tasks/:idTask/notifications`.

  **Verificado contra un destino de mentiras controlable**, los siete casos: 200 a la primera →
  1 intento y `succeeded`; 500, 500, 200 → 3 intentos y `succeeded`; siempre 500 → 3 intentos y
  `exhausted`; **400 → 1 solo intento**, sin reintentar; nunca responde → 3 intentos `no_response`
  con `httpStatus` nulo; tarea abierta → `notification: null`; tarea inexistente → 404.

  Y el punto que une F2 con F4: **8 tareas cerradas por dos usuarios en paralelo produjeron
  exactamente 8 envíos**, un intento por tarea.
