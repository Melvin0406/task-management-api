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


## Notas de implementación pendientes

- [ ] Los tres requisitos de Confiabilidad (idempotencia, archivado, reintentos).
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

  **Falta desplegar:** el droplet quedó registrado con una llave SSH que no está en esta máquina.
