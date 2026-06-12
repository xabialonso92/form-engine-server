// =============================================================
// Lookup Service
// Verifica el dato maestro del usuario contra la fuente externa del cliente.
// Maneja: usuario nuevo / usuario existente / registro previo en progreso.
// =============================================================

import type { LookupConfig, CategoryRule, FormSchema } from '../schema/types'

export type LookupOutcome = 'found' | 'resume' | 'not_found' | 'error'

export interface LookupResponse {
  outcome: LookupOutcome
  category?: string
  prefill?: Record<string, unknown>     // campo_id → valor
  last_step?: number                    // para resume
  submission_id?: string               // submission en progreso
  message?: string                     // mensaje a mostrar al usuario
  can_continue?: boolean
  can_start_over?: boolean
  locked_fields?: string[]             // campos que no se pueden editar
}

export interface LookupCacheEntry {
  result: LookupResponse
  cached_at: number
}

// ─── Interfaz del cliente (inyectable para testing) ──────────

export interface LookupClientAdapter {
  query(endpoint: string, method: string, payload: unknown, headers: Record<string, string>): Promise<unknown>
}

export interface CacheAdapter {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
}

export interface SubmissionRepository {
  findInProgress(formId: string, triggerField: string, value: string): Promise<{ id: string; last_step?: number } | null>
}

// ─── Servicio ──────────────────────────────────────────────────

export class LookupService {
  private readonly CACHE_TTL = 300   // 5 minutos

  constructor(
    private http: LookupClientAdapter,
    private cache: CacheAdapter,
    private submissions: SubmissionRepository,
  ) {}

  async lookup(
    schema: FormSchema,
    triggerValue: string,
  ): Promise<LookupResponse> {
    const config = schema.lookup
    if (!config) return { outcome: 'not_found' }

    const cacheKey = `lookup:${schema.id}:${config.trigger_field}:${triggerValue}`

    // Primero: verificar si hay un registro en progreso en nuestra BD
    const inProgress = await this.submissions.findInProgress(
      schema.id,
      config.trigger_field,
      triggerValue,
    )
    if (inProgress && config.on_resume) {
      return this.buildResumeResponse(config, inProgress)
    }

    // Segundo: intentar desde cache
    const cached = await this.cache.get(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached) as LookupResponse
      } catch {
        // cache corrupto, ignorar
      }
    }

    // Tercero: consultar la fuente externa
    let externalData: unknown = null
    try {
      externalData = await this.http.query(
        config.endpoint,
        config.method ?? 'POST',
        { [config.trigger_field]: triggerValue },
        config.headers ?? {},
      )
    } catch (err) {
      return { outcome: 'error', message: 'No se pudo verificar el dato en este momento' }
    }

    const response = this.buildResponse(config, externalData, triggerValue)

    // Guardar en cache solo si encontró resultado
    if (response.outcome === 'found') {
      await this.cache.set(cacheKey, JSON.stringify(response), this.CACHE_TTL)
    }

    return response
  }

  // ─── Construcción de respuestas ─────────────────────────────

  private buildResponse(
    config: LookupConfig,
    externalData: unknown,
    _value: string,
  ): LookupResponse {
    if (!externalData || isEmptyResponse(externalData)) {
      return {
        outcome: 'not_found',
        message: resolveMessage(config.on_not_found?.show_message as string ?? null),
      }
    }

    const data = externalData as Record<string, unknown>
    const category = config.on_found?.assign_category
      ? (resolvePath(data, config.on_found.assign_category) as string | undefined)
      : undefined

    // Pre-llenar campos
    const prefill: Record<string, unknown> = {}
    for (const [fieldId, jsonPath] of Object.entries(config.on_found?.prefill_fields ?? {})) {
      const val = resolvePath(data, jsonPath)
      if (val !== undefined) prefill[fieldId] = val
    }

    // Campos bloqueados
    const locked_fields = config.on_found?.lock_prefilled
      ? Object.keys(prefill)
      : []

    const response: LookupResponse = {
      outcome: 'found',
      category,
      prefill,
      locked_fields,
      message: resolveMessage(config.on_found?.show_message as string, prefill),
    }

    // Aplicar reglas de categoría
    if (category && config.category_rules) {
      this.applyCategoryRules(response, category, config.category_rules)
    }

    return response
  }

  private buildResumeResponse(
    config: LookupConfig,
    inProgress: { id: string; last_step?: number },
  ): LookupResponse {
    const onResume = config.on_resume!
    return {
      outcome: 'resume',
      submission_id: inProgress.id,
      last_step: inProgress.last_step,
      message: resolveMessage(onResume.show_message as string),
      can_continue: onResume.actions?.includes('continue') ?? true,
      can_start_over: onResume.actions?.includes('start_over') ?? true,
    }
  }

  private applyCategoryRules(
    response: LookupResponse,
    category: string,
    rules: CategoryRule[],
  ): void {
    const rule = rules.find(r => r.if_category === category)
    if (!rule) return

    if (rule.unlock_fields) {
      response.locked_fields = (response.locked_fields ?? []).filter(
        f => !rule.unlock_fields!.includes(f),
      )
    }

    // Los set_field y hide_payment_block se pasan al cliente para que
    // el Form Engine los aplique sobre los datos iniciales
    if (rule.set_field) {
      response.prefill = { ...response.prefill, ...rule.set_field }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function isEmptyResponse(data: unknown): boolean {
  if (data === null || data === undefined) return true
  if (typeof data === 'object' && Object.keys(data as object).length === 0) return true
  // Muchas APIs devuelven { found: false } o { exists: false }
  const d = data as Record<string, unknown>
  if (d.found === false || d.exists === false || d.success === false) return true
  return false
}

// Resolución simple de JsonPath (subset: $.prop y $.nested.prop)
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  if (!path.startsWith('$.')) return undefined
  const keys = path.slice(2).split('.')
  let current: unknown = obj
  for (const key of keys) {
    if (current === null || current === undefined) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function resolveMessage(
  template: string | null | undefined,
  vars: Record<string, unknown> = {},
): string | undefined {
  if (!template) return undefined
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''))
}
