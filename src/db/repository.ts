import { Pool } from 'pg'
import type { FormSchema, Submission } from '../schema/types'

let pool: Pool | null = null

function getPool(): Pool {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL no definida')
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
    })
    pool.on('error', err => console.error('[DB] Pool error:', err))
  }
  return pool
}

async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await getPool().query(sql, params)
  return rows as T[]
}

// =============================================================
// Formularios
// =============================================================

export const formsRepo = {
  async findAll(): Promise<FormSchema[]> {
    const rows = await query<{ schema: FormSchema }>(
      `SELECT schema FROM forms WHERE status != 'archived' ORDER BY created_at DESC`
    )
    return rows.map(r => r.schema)
  },

  async findById(id: string): Promise<FormSchema | null> {
    const rows = await query<{ schema: FormSchema }>(
      `SELECT schema FROM forms WHERE id = $1 LIMIT 1`, [id]
    )
    return rows[0]?.schema ?? null
  },

  async findBySlug(slug: string): Promise<FormSchema | null> {
    const rows = await query<{ schema: FormSchema }>(
      `SELECT schema FROM forms WHERE slug = $1 LIMIT 1`, [slug]
    )
    return rows[0]?.schema ?? null
  },

  async upsert(schema: FormSchema): Promise<void> {
    await query(
      `INSERT INTO forms (id, slug, version, status, schema)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         slug=EXCLUDED.slug, version=EXCLUDED.version,
         status=EXCLUDED.status, schema=EXCLUDED.schema, updated_at=NOW()`,
      [schema.id, schema.slug, schema.version, schema._status ?? 'draft', JSON.stringify(schema)]
    )
    if (schema._status === 'published') {
      await query(
        `INSERT INTO form_versions (form_id, version, schema)
         VALUES ($1, $2, $3) ON CONFLICT (form_id, version) DO NOTHING`,
        [schema.id, schema.version, JSON.stringify(schema)]
      )
    }
  },
}

// =============================================================
// Submissions
// =============================================================

export const submissionsRepo = {

  async findById(id: string): Promise<Submission | null> {
    const rows = await query(
      `SELECT id, form_id, form_version, status, data, lookup_result,
              assigned_category, pricing_snapshot, payment_intent_id,
              paid_at, last_step, host(ip_address) as ip_address,
              user_agent, started_at, completed_at
       FROM submissions WHERE id = $1 LIMIT 1`, [id]
    )
    return rows[0] ? rowToSubmission(rows[0]) : null
  },

  async findInProgress(formId: string, field: string, value: string): Promise<Submission | null> {
    const safeField = field.replace(/[^a-z_]/gi, '')
    const rows = await query(
      `SELECT id, form_id, form_version, status, data, last_step, started_at
       FROM submissions
       WHERE form_id = $1
         AND data->>'${safeField}' = $2
         AND status IN ('in_progress','pending_payment')
       ORDER BY started_at DESC LIMIT 1`,
      [formId, value]
    )
    return rows[0] ? rowToSubmission(rows[0]) : null
  },

  async insert(s: Submission): Promise<void> {
    await query(
      `INSERT INTO submissions
         (id, form_id, form_version, status, data, lookup_result,
          assigned_category, pricing_snapshot, payment_intent_id,
          last_step, ip_address, user_agent, started_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        s.id, s.form_id, s.form_version, s.status,
        JSON.stringify(s.data),
        s.lookup_result    ? JSON.stringify(s.lookup_result)    : null,
        s.assigned_category ?? null,
        s.pricing_snapshot ? JSON.stringify(s.pricing_snapshot) : null,
        s.payment_intent_id ?? null,
        s.last_step ?? 0,
        s.ip_address ?? null,
        s.user_agent ?? null,
        s.started_at,
        s.completed_at ?? null,
      ]
    )
  },

  async update(id: string, patch: Partial<Submission>): Promise<void> {
    const sets: string[] = []
    const vals: unknown[] = []
    let i = 1
    if (patch.status       !== undefined) { sets.push(`status=$${i++}`);       vals.push(patch.status) }
    if (patch.paid_at      !== undefined) { sets.push(`paid_at=$${i++}`);      vals.push(patch.paid_at) }
    if (patch.completed_at !== undefined) { sets.push(`completed_at=$${i++}`); vals.push(patch.completed_at) }
    if (patch.last_step    !== undefined) { sets.push(`last_step=$${i++}`);    vals.push(patch.last_step) }
    if (patch.data         !== undefined) { sets.push(`data=$${i++}`);         vals.push(JSON.stringify(patch.data)) }
    if (!sets.length) return
    vals.push(id)
    await getPool().query(
      `UPDATE submissions SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${i}`, vals
    )
  },

  // ── Dashboard ──────────────────────────────────────────────

  async findByForm({ formId, limit, offset, status, search }: {
    formId: string; limit: number; offset: number; status?: string; search?: string
  }): Promise<{ rows: Submission[]; total: number }> {
    const conditions = [`form_id = $1`]
    const params: unknown[] = [formId]
    let p = 2

    if (status) { conditions.push(`status = $${p++}`); params.push(status) }
    if (search) {
      conditions.push(`(data::text ILIKE $${p} OR assigned_category ILIKE $${p})`)
      params.push(`%${search}%`)
      p++
    }

    const where = `WHERE ${conditions.join(' AND ')}`

    const countRows = await getPool().query(
      `SELECT COUNT(*) as total FROM submissions ${where}`, params
    )
    const total = parseInt(countRows.rows[0].total)

    const dataRows = await getPool().query(
      `SELECT id, form_id, form_version, status, data, assigned_category,
              pricing_snapshot, payment_intent_id, paid_at,
              started_at, completed_at
       FROM submissions ${where}
       ORDER BY started_at DESC
       LIMIT $${p} OFFSET $${p+1}`,
      [...params, limit, offset]
    )

    return { rows: dataRows.rows.map(rowToSubmission), total }
  },

  async getStats(formId: string): Promise<{
    total: number; completed: number; pending_payment: number;
    in_progress: number; cancelled: number;
    revenue: number; currency: string; conversion_rate: number
  }> {
    const rows = await query(
      `SELECT
         COUNT(*)                                              AS total,
         COUNT(*) FILTER (WHERE status='completed')           AS completed,
         COUNT(*) FILTER (WHERE status='pending_payment')     AS pending_payment,
         COUNT(*) FILTER (WHERE status='in_progress')         AS in_progress,
         COUNT(*) FILTER (WHERE status='cancelled')           AS cancelled,
         COALESCE(SUM((pricing_snapshot->>'total')::NUMERIC)
           FILTER (WHERE status='completed'), 0)              AS revenue
       FROM submissions WHERE form_id = $1`, [formId]
    )
    const r = rows[0] ?? {}
    const total     = parseInt(r.total     ?? '0')
    const completed = parseInt(r.completed ?? '0')
    return {
      total,
      completed,
      pending_payment: parseInt(r.pending_payment ?? '0'),
      in_progress:     parseInt(r.in_progress     ?? '0'),
      cancelled:       parseInt(r.cancelled       ?? '0'),
      revenue:         parseFloat(r.revenue       ?? '0'),
      currency:        'USD',
      conversion_rate: total > 0 ? Math.round((completed / total) * 100) : 0,
    }
  },
}

function rowToSubmission(r: any): Submission {
  const j = (v: any) => typeof v === 'string' ? JSON.parse(v) : v
  return {
    id: r.id, form_id: r.form_id, form_version: r.form_version, status: r.status,
    data: j(r.data),
    lookup_result:     r.lookup_result     ? j(r.lookup_result)     : undefined,
    assigned_category: r.assigned_category ?? undefined,
    pricing_snapshot:  r.pricing_snapshot  ? j(r.pricing_snapshot)  : undefined,
    payment_intent_id: r.payment_intent_id ?? undefined,
    paid_at:           r.paid_at?.toISOString?.()      ?? undefined,
    last_step:         r.last_step         ?? undefined,
    ip_address:        r.ip_address        ?? undefined,
    user_agent:        r.user_agent        ?? undefined,
    started_at:        r.started_at?.toISOString?.()   ?? new Date().toISOString(),
    completed_at:      r.completed_at?.toISOString?.() ?? undefined,
  }
}
