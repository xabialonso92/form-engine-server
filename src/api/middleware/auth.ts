// =============================================================
// Middleware de autenticación
// Las rutas de admin (CRUD de formularios) requieren API key.
// Las rutas públicas (lookup, submit) no.
// =============================================================

import type { Request, Response, NextFunction } from 'express'

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = process.env.API_SECRET_KEY
  if (!key) {
    res.status(500).json({ error: 'API_SECRET_KEY no configurada en el servidor' })
    return
  }

  const provided =
    req.headers['x-api-key'] ??
    req.headers['authorization']?.replace('Bearer ', '')

  if (!provided || provided !== key) {
    res.status(401).json({ error: 'No autorizado — API key requerida' })
    return
  }

  next()
}

// Middleware para Stripe webhooks — necesita el body raw (Buffer)
export function rawBodyMiddleware(req: Request, _res: Response, buf: Buffer): void {
  (req as any).rawBody = buf
}
