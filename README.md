# Task Management API

[![CI](https://github.com/Melvin0406/task-management-api/actions/workflows/ci.yml/badge.svg)](https://github.com/Melvin0406/task-management-api/actions/workflows/ci.yml)

Tareas asignadas a varias personas. Cuando todas terminan su parte, la tarea se archiva sola y se
notifica a un sistema externo.

**API en vivo:** <https://167-99-2-144.sslip.io> · comprobar con `GET /health`
Node.js + TypeScript · Express · MySQL 8.4 · Docker Compose

> Este README se mantiene en 2 páginas. El razonamiento completo de cada decisión está en
> [`docs/decisiones.md`](docs/decisiones.md).

## Correr en local, y tests

```bash
cp .env.example .env
docker compose up -d     # MySQL en el puerto 3308
npm install
npm run migrate          # aplica migrations/*.sql
npm run dev              # http://localhost:3000

npm test                 # 50 tests de integración sobre HTTP
```

Los tests usan su propia base (`taskapi_test`), que se crea y migra sola.
`tests/reliability.test.ts` cubre la sección de Confiabilidad, que es lo que no se puede verificar
leyendo el código. **Se comprobó que fallan al quitar lo que prueban:** sin el `FOR UPDATE` caen los
dos de archivado concurrente, y con idempotencia ingenua —consultar y luego insertar— el test
secuencial **sigue pasando** y caen sólo los dos en paralelo.

## Modelo de datos

**Diagrama entidad-relación con tipos y relaciones:
[`docs/modelo-de-datos.md`](docs/modelo-de-datos.md).** El esquema versionado que lo produce está en
[`migrations/`](migrations/).

Tres restricciones cargan peso: la PK compuesta de `task_assignments` hace imposible duplicar una
asignación, el `UNIQUE` de `notification_jobs.task_id` sostiene "notificar exactamente una vez", y el
`UNIQUE` de `idem_key` es el mutex de toda la idempotencia.

## Decisiones técnicas

- **MySQL, no SQLite.** SQLite serializa las escrituras, así que los requisitos de Confiabilidad se
  cumplirían por accidente del motor y no por diseño.
- **SQL a mano, sin ORM.** Todo se juega en semántica exacta —filas afectadas, conflicto de índice
  único, `FOR UPDATE`—; con un ORM defendería sus decisiones de transacción y no las mías.
- **Archivar exactamente una vez:** `SELECT ... FOR UPDATE` sobre la tarea al abrir la transacción.
  El riesgo obvio es archivar dos veces; **el real es no archivar nunca**: bajo `REPEATABLE READ` dos
  completaciones concurrentes leen snapshots previos, ambas ven trabajo pendiente, ninguna archiva, y
  la tarea queda abierta para siempre con todo terminado.
- **Idempotencia:** nunca se consulta la llave antes de insertarla, porque consultar pierde justo la
  carrera que hay que ganar. El `INSERT` perdedor espera el candado del índice y despierta cuando la
  respuesta del ganador ya está guardada.
- **La respuesta reproducida se guarda como texto, no como `JSON`:** MySQL normaliza el orden de
  llaves en columnas `JSON`, y el reto pide respuestas **idénticas**, no equivalentes.
- **La llamada HTTP nunca ocurre dentro de una transacción.** La transacción que archiva sólo encola
  (*transactional outbox*); un despachador entrega después y reclama el trabajo con
  `UPDATE ... WHERE state='pending'`, así que varias instancias no duplicarían el envío.
- **El timeout por intento es indispensable:** sin él, un destino que acepta la conexión y no
  contesta cuelga la petición para siempre y la política de reintentos nunca corre.

## Supuestos ante ambigüedades

- **`Idempotency-Key` es opcional:** el reto dice que los POST deben *aceptar* el header, no
  exigirlo. Aparte, 3 de los 4 POST ya son idempotentes por diseño de dominio.
- La llave tiene **alcance global**: reusarla en otro endpoint o con otro cuerpo da 409.
- **Los errores no se memorizan:** una petición fallida libera su llave para poder reintentar.
- **4xx en la notificación no se reintenta.** El reto nombra 5xx y sin-respuesta; un destino que
  entendió y rechazó rechazará lo mismo las tres veces.
- **Id de ruta no numérico → 400, no 404:** el recurso no falta, la petición nunca nombró uno. Igual
  `?status` desconocido → 400 y no lista vacía.
- **Repetir `complete` es éxito**, también cuando llega después de archivarse. `assign` sobre tarea
  archivada → 409. Email repetido → 409. Campo no reconocido → 400. `userIds` se deduplica y los
  usuarios inexistentes se nombran todos de una vez.

## Despliegue

Droplet de DigitalOcean (1 vCPU, 1 GB, Ubuntu 24.04), que es la infraestructura que operé en
producción durante un año. **1 GB y no 512 MB** porque MySQL 8 arranca sobre 400 MB con sus defaults:
medido en marcha son 569 MB de 961, con MySQL en 215 MB tras apagar `performance-schema`.

**Nginx y certbot corren en el host, no en Compose**, y es la decisión menos obvia: el reto exige que
la URL siga viva 7 días sin supervisión, y `certbot --nginx` instala su propio timer de renovación.
`sslip.io` da certificado real de Let's Encrypt sin comprar dominio. La API sólo escucha en
`127.0.0.1:3000`, MySQL nunca se publica y el firewall abre 22, 80 y 443. Tras un `reboot` la pila
vuelve sola en ~40 s con los datos intactos.

**CI/CD.** [`ci.yml`](.github/workflows/ci.yml) corre typecheck y los 50 tests en cada push contra un
MySQL real. [`deploy.yml`](.github/workflows/deploy.yml) despliega **a disparo manual**: la URL está
comprometida 7 días y automatizar cada push la dejaría a merced de cualquier commit.

## Mejora adicional: dead-letter con reenvío manual

`GET /notifications/dead-letter` · `POST /notifications/:idJob/retry`

**Qué problema resuelve.** El enunciado se detiene tras 3 intentos fallidos y no dice qué sigue. Ahí
queda un hueco: **la notificación se pierde en silencio** y el sistema del cliente nunca se entera de
que la tarea se archivó. Nadie lo nota, porque la API respondió 200 media hora antes.

**Por qué era necesaria.** Todo el reto trata de mantener consistencia pese a fallos transitorios. Un
fallo que dura más que 3 intentos —un despliegue del cliente, una caída de 10 minutos— rompe esa
consistencia de forma permanente y sin dejar señal.

**Por qué sobre otras alternativas.** Auth, rate limiting o Swagger resuelven problemas que el
enunciado no planteó. Ésta cierra un hueco que el propio enunciado abrió, sigue el hilo de la
Confiabilidad, y **reusa la tabla y el despachador existentes**: son dos endpoints y un `UPDATE`. El
reenvío usa la misma técnica que el resto —`UPDATE ... WHERE state='exhausted'`— así que dos
operadores dando clic a la vez producen **un** reencolado. Otorga un ciclo nuevo de 3 intentos, y el
log numera de forma monótona entre ciclos para conservar el historial completo.

## Qué se recortó

- **Despachador en el mismo proceso** en vez de un contenedor aparte. El estado vive en la base, así
  que sobrevive reinicios; en producción sería su propio servicio.
- **Sin autenticación** (el reto no la pide y competiría con la mejora elegida), **sin paginación**
  (al volumen de una evaluación sólo añade superficie) y **sin métricas ni tracing** (el log de
  intentos cubre la observabilidad que el reto exige).
