// =============================================================
// server.ts — punto de entrada
// Hostinger ejecuta: npm start → node dist/server.js
// =============================================================

import * as dotenv from 'dotenv'
dotenv.config()

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { createRouter, handleStripeWebhook } from './api/routes'
import { rawBodyMiddleware } from './api/middleware/auth'

const app  = express()
const PORT = Number(process.env.PORT ?? 3000)

// ─── Seguridad base ───────────────────────────────────────────

app.use(helmet())

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

app.use(cors({
  origin: (origin, cb) => {
    // Permitir sin origen (Postman, curl) o en desarrollo
    if (!origin || process.env.NODE_ENV === 'development') return cb(null, true)
    if (allowedOrigins.includes(origin)) return cb(null, true)
    cb(new Error(`Origen ${origin} no permitido por CORS`))
  },
  credentials: true,
}))

// ─── Webhook de Stripe ANTES del body parser (necesita raw body) ──

app.post(
  '/api/webhooks/stripe',
  express.raw({ type: 'application/json', verify: rawBodyMiddleware }),
  handleStripeWebhook,
)

// ─── Body parsers ─────────────────────────────────────────────

app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))

// ─── Rate limiting ────────────────────────────────────────────

// General: 100 req/min por IP
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max:      100,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Demasiadas solicitudes, intenta en un minuto' },
}))

// Lookup: 20 req/min (evitar abuso de dato maestro)
app.use('/api/forms/:id/lookup', rateLimit({
  windowMs: 60 * 1000,
  max:      20,
  message:  { error: 'Límite de verificaciones alcanzado' },
}))

// ─── Rutas ────────────────────────────────────────────────────

app.use('/api/forms', createRouter())

// Health check — Hostinger lo usa para verificar que el proceso corre
app.get('/health', (_req, res) => {
  res.json({
    status:  'ok',
    version: '1.0.0',
    env:     process.env.NODE_ENV ?? 'development',
    time:    new Date().toISOString(),
  })
})

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' })
})

// Error handler global
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const isDev = process.env.NODE_ENV !== 'production'
  console.error('[Error]', err.message, isDev ? err.stack : '')

  if (err.message.includes('no permitido por CORS')) {
    return res.status(403).json({ error: err.message })
  }

  res.status(500).json({
    error:   'Error interno del servidor',
    message: isDev ? err.message : 'Contacta al administrador',
  })
})

// ─── Arrancar ─────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
  ┌──────────────────────────────────────────┐
  │   Form Engine API                        │
  │   http://localhost:${PORT}                   │
  │   Entorno: ${(process.env.NODE_ENV ?? 'development').padEnd(10)}                │
  └──────────────────────────────────────────┘
  `)
})

export default app
