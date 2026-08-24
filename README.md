# Task Management API

API REST de gestión de trabajo colaborativo: tareas asignadas a varias personas, que se archivan
automáticamente y notifican a un sistema externo cuando todos los asignados terminan su parte.

**API desplegada:** _(pendiente — F1)_

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

_(Pendiente — dónde, por qué y cómo acceder. F1 y F7.)_

---

## Mejora adicional

_(Pendiente — qué problema resuelve, por qué era necesaria, por qué sobre otras alternativas. F8.)_

---

## Qué se recortó por falta de tiempo

_(Pendiente.)_
