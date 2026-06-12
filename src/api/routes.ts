import { Router, Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import type { FormSchema, Submission } from '../schema/types'
import { validateSchema } from '../schema/validator'
import { FormEngine } from '../engine/form-engine'
import { PricingEngine, buildPricingSnapshot } from '../pricing/pricing-engine'
import { LookupService } from '../lookup/lookup-service'
import { formsRepo, submissionsRepo } from '../db/repository'
import { redisCacheAdapter } from '../db/cache'
import { httpLookupAdapter } from '../lookup/http-adapter'
import { stripeAdapter } from './stripe-adapter'
import { requireApiKey } from './middleware/auth'

const lookupService = new LookupService(
  httpLookupAdapter,
  redisCacheAdapter,
  {
    findInProgress: async (formId, field, value) => {
      const sub = await submissionsRepo.findInProgress(formId, field, value)
      if (!sub) return null
      return { id: sub.id, last_step: sub.last_step }
    },
  },
)

export function createRouter(): Router {
  const router = Router()

  // ── Admin: CRUD formularios ────────────────────────────────

  router.get('/', requireApiKey, async (_req, res, next) => {
    try {
      res.json({ data: await formsRepo.findAll() })
    } catch (e) { next(e) }
  })

  router.post('/', requireApiKey, async (req, res, next) => {
    try {
      const schema: FormSchema = {
        ...req.body, id: req.body.id ?? randomUUID(),
        version: 1, _status: 'draft',
        _created_at: new Date().toISOString(),
        _updated_at: new Date().toISOString(),
      }
      const v = validateSchema(schema)
      if (!v.valid) return res.status(400).json({ errors: v.errors, warnings: v.warnings })
      await formsRepo.upsert(schema)
      res.status(201).json({ data: schema, warnings: v.warnings })
    } catch (e) { next(e) }
  })

  router.get('/:id', async (req, res, next) => {
    try {
      const form = await formsRepo.findById(req.params.id) ?? await formsRepo.findBySlug(req.params.id)
      if (!form) return res.status(404).json({ error: 'Formulario no encontrado' })
      const isAdmin = req.headers['x-api-key'] === process.env.API_SECRET_KEY
      if (!isAdmin && form._status !== 'published') return res.status(404).json({ error: 'Formulario no disponible' })
      res.json({ data: form })
    } catch (e) { next(e) }
  })

  router.put('/:id', requireApiKey, async (req, res, next) => {
    try {
      const existing = await formsRepo.findById(req.params.id)
      if (!existing) return res.status(404).json({ error: 'Formulario no encontrado' })
      const schema: FormSchema = {
        ...existing, ...req.body, id: existing.id,
        version: existing._status === 'published' ? existing.version + 1 : existing.version,
        _updated_at: new Date().toISOString(),
      }
      const v = validateSchema(schema)
      if (!v.valid) return res.status(400).json({ errors: v.errors })
      await formsRepo.upsert(schema)
      res.json({ data: schema, warnings: v.warnings })
    } catch (e) { next(e) }
  })

  router.post('/:id/publish', requireApiKey, async (req, res, next) => {
    try {
      const form = await formsRepo.findById(req.params.id)
      if (!form) return res.status(404).json({ error: 'Formulario no encontrado' })
      const v = validateSchema(form)
      if (!v.valid) return res.status(400).json({ error: 'El formulario tiene errores', errors: v.errors })
      const published = { ...form, _status: 'published' as const, _updated_at: new Date().toISOString() }
      await formsRepo.upsert(published)
      res.json({ data: published })
    } catch (e) { next(e) }
  })

  router.delete('/:id', requireApiKey, async (req, res, next) => {
    try {
      const form = await formsRepo.findById(req.params.id)
      if (!form) return res.status(404).json({ error: 'Formulario no encontrado' })
      await formsRepo.upsert({ ...form, _status: 'archived' as const })
      res.json({ message: 'Formulario archivado' })
    } catch (e) { next(e) }
  })

  // ── Dashboard ──────────────────────────────────────────────

  router.get('/:id/submissions', requireApiKey, async (req, res, next) => {
    try {
      const form = await formsRepo.findById(req.params.id) ?? await formsRepo.findBySlug(req.params.id)
      if (!form) return res.status(404).json({ error: 'Formulario no encontrado' })

      const page   = Math.max(1, parseInt(String(req.query.page  ?? '1')))
      const limit  = Math.min(100, parseInt(String(req.query.limit ?? '50')))
      const status = String(req.query.status ?? '')
      const search = String(req.query.search ?? '').trim()

      const { rows, total } = await submissionsRepo.findByForm({
        formId: form.id, limit, offset: (page - 1) * limit,
        status: status || undefined, search: search || undefined,
      })

      res.json({ data: rows, meta: { total, page, limit, pages: Math.ceil(total / limit) } })
    } catch (e) { next(e) }
  })

  router.get('/:id/stats', requireApiKey, async (req, res, next) => {
    try {
      const form = await formsRepo.findById(req.params.id) ?? await formsRepo.findBySlug(req.params.id)
      if (!form) return res.status(404).json({ error: 'Formulario no encontrado' })
      res.json({ data: await submissionsRepo.getStats(form.id) })
    } catch (e) { next(e) }
  })

  // ── Público: lookup + submit ───────────────────────────────

  router.post('/:id/lookup', async (req, res, next) => {
    try {
      const form = await formsRepo.findBySlug(req.params.id) ?? await formsRepo.findById(req.params.id)
      if (!form || form._status !== 'published') return res.status(404).json({ error: 'Formulario no encontrado' })
      if (!form.lookup) return res.json({ data: { outcome: 'not_found' } })
      const { value } = req.body
      if (!value || typeof value !== 'string') return res.status(400).json({ error: '"value" requerido' })
      res.json({ data: await lookupService.lookup(form, value.trim()) })
    } catch (e) { next(e) }
  })

  router.post('/:id/submit', async (req, res, next) => {
    try {
      const form = await formsRepo.findBySlug(req.params.id) ?? await formsRepo.findById(req.params.id)
      if (!form || form._status !== 'published') return res.status(404).json({ error: 'Formulario no disponible' })

      const { data, submission_id: existingId, lookup_category, lookup_result, started_at } = req.body
      const engine = new FormEngine(form)
      const evaluated = engine.evaluate(data)
      if (!evaluated.isValid) return res.status(422).json({ error: 'Errores de validación', field_errors: evaluated.errors })

      const sanitized = engine.sanitizeData(data)
      let pricingSnapshot: Submission['pricing_snapshot'] | undefined
      let paymentIntentClientSecret: string | undefined
      let paymentIntentId: string | undefined

      if (form.pricing && form.payment) {
        const pe = new PricingEngine(form.pricing, lookup_category)
        const result = pe.calculate(sanitized)
        pricingSnapshot = buildPricingSnapshot(result)
        if (result.total > 0 && form.payment.provider === 'stripe') {
          const submissionId = existingId ?? randomUUID()
          const intent = await stripeAdapter.createPaymentIntent({
            amount: result.amount_for_stripe, currency: result.currency.toLowerCase(),
            metadata: { form_id: form.id, form_slug: form.slug, submission_id: submissionId },
          })
          paymentIntentClientSecret = intent.client_secret
          paymentIntentId = intent.id
        }
      }

      const submissionId = existingId ?? randomUUID()
      const now = new Date().toISOString()
      const requiresPayment = !!paymentIntentClientSecret

      await submissionsRepo.insert({
        id: submissionId, form_id: form.id, form_version: form.version,
        status: requiresPayment ? 'pending_payment' : 'completed',
        data: sanitized, pricing_snapshot: pricingSnapshot,
        payment_intent_id: paymentIntentId,
        assigned_category: lookup_category, lookup_result,
        started_at: started_at ?? now,
        completed_at: requiresPayment ? undefined : now,
        ip_address: req.ip, user_agent: req.headers['user-agent'],
      })

      res.status(201).json({
        data: {
          submission_id: submissionId, status: requiresPayment ? 'pending_payment' : 'completed',
          pricing: pricingSnapshot, payment_intent_client_secret: paymentIntentClientSecret,
          requires_payment: requiresPayment,
        },
      })
    } catch (e) { next(e) }
  })

  router.get('/submissions/:id', async (req, res, next) => {
    try {
      const sub = await submissionsRepo.findById(req.params.id)
      if (!sub) return res.status(404).json({ error: 'Registro no encontrado' })
      res.json({ data: sub })
    } catch (e) { next(e) }
  })

  router.post('/submissions/:id/payment-complete', async (req, res, next) => {
    try {
      const sub = await submissionsRepo.findById(req.params.id)
      if (!sub) return res.status(404).json({ error: 'Registro no encontrado' })
      if (sub.payment_intent_id) {
        const paid = await stripeAdapter.confirmPaymentIntentPaid(sub.payment_intent_id)
        if (!paid) return res.status(400).json({ error: 'Pago no confirmado en Stripe' })
      }
      const now = new Date().toISOString()
      await submissionsRepo.update(sub.id, { status: 'completed', paid_at: now, completed_at: now })
      res.json({ data: { status: 'completed', submission_id: sub.id } })
    } catch (e) { next(e) }
  })

  return router
}

export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const sig = req.headers['stripe-signature'] as string
  const rawBody = (req as any).rawBody as Buffer
  if (!sig || !rawBody) { res.status(400).json({ error: 'Falta firma o body' }); return }
  let event
  try { event = stripeAdapter.constructWebhookEvent(rawBody, sig) }
  catch (err: any) { res.status(400).json({ error: `Webhook inválido: ${err.message}` }); return }
  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object as any
    const submissionId = intent.metadata?.submission_id
    if (submissionId) {
      const now = new Date().toISOString()
      await submissionsRepo.update(submissionId, { status: 'completed', paid_at: now, completed_at: now })
    }
  }
  res.json({ received: true })
}
