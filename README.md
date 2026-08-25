# Task Management API

API REST de gestión de trabajo colaborativo: tareas asignadas a varias personas, que se archivan
automáticamente y notifican a un sistema externo cuando todos los asignados terminan su parte.

**API desplegada:** <https://167-99-2-144.sslip.io>  ·  `GET /health` para comprobar que está viva.

---

## Cómo correrlo localmente

```bash
cp .env.example .env
docker compose up -d          # MySQL 8.4 en el puerto 3308
npm install
npm run migrate               # aplica migrations/*.sql
npm run dev                   # http://localhost:3000
```

Verificación rápida:

```bash
curl http://localhost:3000/health
# {"status":"ok","database":"up"}
```

## Tests

```bash
npm test
```

_(Pendiente — F6.)_

---

## Modelo de datos

_(Pendiente — diagrama Mermaid y tipos. F8.)_

---

## Decisiones técnicas

_(Pendiente — se redacta a partir de `docs/decisiones.md`.)_

---

## Supuestos ante ambigüedades

_(Pendiente — se acumulan en `docs/decisiones.md` conforme se toman.)_

---

## Despliegue

**Dónde:** droplet de DigitalOcean (1 vCPU, 1 GB, Ubuntu 24.04), en
<https://167-99-2-144.sslip.io>.

**Por qué:**

- **DigitalOcean** porque es la infraestructura que operé en producción durante un año, así que las
  decisiones de la caja las puedo defender. Sobre AWS pesó la familiaridad: a la escala de este reto
  la diferencia de costo es de un dólar, y el riesgo de una plataforma que no domino no lo es.
- **1 GB y no 512 MB.** MySQL 8 arranca en más de 400 MB con sus defaults; sumando Docker, Node y
  Nginx, la caja de 512 MB se pasa y el OOM killer se lleva a MySQL. Medido ya corriendo: **569 MB
  usados de 961**, con MySQL en 215 MB tras apagar `performance-schema`.
- **Nginx y certbot en el host, no en Compose.** Es la decisión menos obvia y la razón es el
  requisito de que la URL siga viva 7 días sin supervisión: `certbot --nginx` instala su propio
  timer de renovación en systemd. Dentro de Compose ese ciclo de vida habría que mantenerlo a mano.
- **`sslip.io`** resuelve `167-99-2-144.sslip.io` a la IP del servidor, lo que permite un
  certificado real de Let's Encrypt sin comprar dominio.

**Cómo está armado:** la API y MySQL corren en Docker Compose; la API sólo escucha en
`127.0.0.1:3000`, así que la única entrada desde internet es Nginx. MySQL nunca se publica, y el
firewall abre únicamente 22, 80 y 443. Hay 1 GB de swap con `vm.swappiness=10` como seguro contra
picos de memoria.

**Verificado:** tras un `reboot`, la pila vuelve sola en ~40 segundos con los datos intactos, y
`certbot renew --dry-run` pasa.

Scripts en [`deploy/`](deploy/): `setup-server.sh` (bootstrap, idempotente) y `deploy.sh`
(actualizar y migrar).

---

## Mejora adicional

_(Pendiente — qué problema resuelve, por qué era necesaria, por qué sobre otras alternativas. F8.)_

---

## Qué se recortó por falta de tiempo

_(Pendiente.)_
