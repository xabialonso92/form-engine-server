# Deploy en Railway — guía completa

## Qué vas a crear

Un proyecto Railway con 3 servicios, todo en un solo lugar:
- App Node.js (tu código)
- PostgreSQL (base de datos)
- Redis (cache del lookup)

Un solo dashboard, una sola factura (~$5-10/mes según uso).

---

## Paso 1 — Subir el código a GitHub

```bash
# En la carpeta del proyecto
git init
git add .
git commit -m "form engine inicial"

# Crear un repo en github.com y conectarlo
git remote add origin https://github.com/TU_USUARIO/form-engine.git
git push -u origin main
```

---

## Paso 2 — Crear el proyecto en Railway

1. Ir a **railway.app** → crear cuenta (se puede con GitHub)
2. **New Project → Deploy from GitHub repo**
3. Seleccionar el repo que acabas de subir
4. Railway detecta el `railway.toml` y arranca el build automáticamente

---

## Paso 3 — Agregar PostgreSQL

1. En tu proyecto Railway → **+ New Service → Database → PostgreSQL**
2. Listo. Railway crea la BD y **automáticamente** agrega `DATABASE_URL`
   a las variables de entorno de tu app Node. No copias nada.

---

## Paso 4 — Agregar Redis

1. En tu proyecto Railway → **+ New Service → Database → Redis**
2. Igual que PostgreSQL: Railway inyecta `REDIS_URL` automáticamente.

---

## Paso 5 — Agregar las variables manuales

En tu servicio Node.js → **Variables** → agregar:

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `STRIPE_SECRET_KEY` | `sk_test_...` (de dashboard.stripe.com) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` (lo obtienes en el paso 6) |
| `API_SECRET_KEY` | string aleatorio largo (ver abajo) |
| `ALLOWED_ORIGINS` | URL de tu frontend |

Generar `API_SECRET_KEY` en tu terminal:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Paso 6 — Configurar webhook de Stripe

1. Ir a **dashboard.stripe.com → Developers → Webhooks → Add endpoint**
2. URL: `https://TU-APP.railway.app/api/webhooks/stripe`
3. Eventos: seleccionar `payment_intent.succeeded`
4. Copiar el **Signing secret** (`whsec_...`) y pegarlo en Railway como `STRIPE_WEBHOOK_SECRET`
5. Hacer redeploy (Railway → tu servicio → Redeploy)

---

## Paso 7 — Correr la migración

Solo se hace una vez. En la terminal de Railway (o en tu terminal local con Railway CLI):

```bash
# Opción A — desde Railway dashboard
# Tu servicio → Settings → Deploy → "Run a one-off command"
# Escribir: node dist/db/migrate.js

# Opción B — desde tu terminal con Railway CLI
npm install -g @railway/cli
railway login
railway link   # seleccionar tu proyecto
railway run node dist/db/migrate.js
```

Verás:
```
✓ forms
✓ submissions
✓ form_versions
✓ triggers updated_at
✅ Migración completada
```

---

## Verificar que todo funciona

Abrir: `https://TU-APP.railway.app/health`

Respuesta esperada:
```json
{
  "status": "ok",
  "version": "1.0.0",
  "env": "production"
}
```

---

## Prueba rápida con curl

```bash
export BASE=https://TU-APP.railway.app
export KEY=TU_API_SECRET_KEY

# 1. Crear formulario
curl -s -X POST $BASE/api/forms \
  -H "Content-Type: application/json" \
  -H "x-api-key: $KEY" \
  -d '{
    "slug": "cumbre-2026",
    "meta": { "title": "Cumbre de Innovación 2026" },
    "fields": [
      {
        "id": "email", "type": "email", "label": "Email",
        "required": true, "lookup_target": true,
        "validation": [{ "rule": "email" }]
      },
      { "id": "nombre", "type": "text", "label": "Nombre completo", "required": true },
      {
        "id": "tipo_entrada", "type": "radio", "label": "Tipo de entrada",
        "required": true,
        "options": [
          { "value": "estandar", "label": "Estándar · $150" },
          { "value": "virtual",  "label": "Virtual · $40" }
        ]
      }
    ],
    "pricing": {
      "currency": "USD",
      "base_price": 0,
      "items": [
        {
          "id": "entrada", "label": "Entrada", "type": "field_value",
          "field": "tipo_entrada",
          "options": { "estandar": 150, "virtual": 40 }
        }
      ]
    }
  }' | jq .

# 2. Publicarlo (reemplazar ID con el del paso anterior)
curl -s -X POST $BASE/api/forms/ID_AQUI/publish \
  -H "x-api-key: $KEY" | jq .

# 3. Enviar un registro (ruta pública, sin API key)
curl -s -X POST $BASE/api/forms/cumbre-2026/submit \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "email": "ana@empresa.com",
      "nombre": "Ana García",
      "tipo_entrada": "estandar"
    }
  }' | jq .
```

---

## Deploy automático

A partir de ahora, cada vez que hagas:
```bash
git push origin main
```
Railway detecta el push, compila TypeScript y redespliega en ~1 minuto.
Los logs aparecen en tiempo real en el dashboard.

---

## Resumen de URLs de la API

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| GET | `/health` | — | Health check |
| GET | `/api/forms` | API key | Listar formularios |
| POST | `/api/forms` | API key | Crear formulario |
| GET | `/api/forms/:id` | — (si publicado) | Obtener schema |
| PUT | `/api/forms/:id` | API key | Actualizar |
| POST | `/api/forms/:id/publish` | API key | Publicar |
| DELETE | `/api/forms/:id` | API key | Archivar |
| POST | `/api/forms/:id/lookup` | — | Verificar dato maestro |
| POST | `/api/forms/:id/submit` | — | Enviar registro |
| GET | `/api/forms/submissions/:id` | — | Estado del registro |
| POST | `/api/forms/submissions/:id/payment-complete` | — | Confirmar pago |
| POST | `/api/webhooks/stripe` | Stripe sig | Webhook de pagos |
