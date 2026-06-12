// =============================================================
// Migrate — Railway PostgreSQL
// Ejecutar una sola vez después del primer deploy:
//   railway run npm run migrate
// =============================================================

import { Pool } from 'pg'
import * as dotenv from 'dotenv'
dotenv.config()

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL no definida')

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  })

  const run = async (sql: string) => { await pool.query(sql) }

  console.log('Conectando a PostgreSQL...')

  await run(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)

  await run(`
    CREATE TABLE IF NOT EXISTS forms (
      id          TEXT PRIMARY KEY,
      slug        TEXT NOT NULL UNIQUE,
      version     INTEGER NOT NULL DEFAULT 1,
      status      TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','published','archived')),
      schema      JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  console.log('✓ forms')

  await run(`CREATE INDEX IF NOT EXISTS idx_forms_slug   ON forms (slug)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_forms_status ON forms (status)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_forms_schema ON forms USING GIN (schema)`)

  await run(`
    CREATE TABLE IF NOT EXISTS submissions (
      id                  TEXT PRIMARY KEY,
      form_id             TEXT NOT NULL REFERENCES forms(id) ON DELETE RESTRICT,
      form_version        INTEGER NOT NULL,
      status              TEXT NOT NULL DEFAULT 'in_progress'
                            CHECK (status IN ('in_progress','pending_payment','completed','cancelled')),
      data                JSONB NOT NULL DEFAULT '{}',
      lookup_result       JSONB,
      assigned_category   TEXT,
      pricing_snapshot    JSONB,
      payment_intent_id   TEXT,
      paid_at             TIMESTAMPTZ,
      last_step           INTEGER DEFAULT 0,
      ip_address          INET,
      user_agent          TEXT,
      started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at        TIMESTAMPTZ,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  console.log('✓ submissions')

  await run(`CREATE INDEX IF NOT EXISTS idx_sub_form_id ON submissions (form_id)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_sub_status  ON submissions (status)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_sub_data    ON submissions USING GIN (data)`)
  await run(`
    CREATE INDEX IF NOT EXISTS idx_sub_email
      ON submissions ((data->>'email'))
      WHERE data ? 'email'`)

  await run(`
    CREATE TABLE IF NOT EXISTS form_versions (
      id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      form_id      TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
      version      INTEGER NOT NULL,
      schema       JSONB NOT NULL,
      published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (form_id, version)
    )`)
  console.log('✓ form_versions')

  // Función y trigger para updated_at automático
  await run(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$ LANGUAGE plpgsql`)

  for (const table of ['forms', 'submissions']) {
    await run(`DROP TRIGGER IF EXISTS trg_${table}_updated_at ON ${table}`)
    await run(`
      CREATE TRIGGER trg_${table}_updated_at
        BEFORE UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()`)
  }
  console.log('✓ triggers updated_at')

  await pool.end()
  console.log('\n✅ Migración completada')
  process.exit(0)
}

migrate().catch(err => {
  console.error('Error en migración:', err)
  process.exit(1)
})
