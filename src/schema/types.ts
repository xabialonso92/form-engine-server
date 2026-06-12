// =============================================================
// Form Engine — Schema Types
// Fuente de verdad única: builder, renderer y validación comparten estos tipos
// =============================================================

// ─── Primitivos reutilizables ────────────────────────────────

export type UUID = string
export type ISODate = string
export type JsonPath = string        // Ej: "$.data.full_name"
export type I18nString = string | Record<string, string>

// ─── Tipos de campo ──────────────────────────────────────────

export type FieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'phone'
  | 'number'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'date'
  | 'file'
  | 'attendees'   // sub-formulario de acompañantes
  | 'lookup'      // campo dato maestro (dispara verificación)
  | 'divider'     // separador visual sin dato
  | 'heading'     // título de sección sin dato
  | 'payment'     // bloque Stripe embebido

// ─── Opciones de campo (radio, checkbox, select) ─────────────

export interface FieldOption {
  value: string
  label: I18nString
  description?: I18nString
  price?: number              // precio base de esta opción
  disabled?: boolean
  icon?: string
}

// ─── Validaciones ────────────────────────────────────────────

export type ValidationRule =
  | 'required'
  | 'email'
  | 'phone'
  | 'url'
  | 'min_length'
  | 'max_length'
  | 'min'
  | 'max'
  | 'regex'
  | 'unique_submission'    // no existe submission previa con este valor

export interface Validation {
  rule: ValidationRule
  value?: number | string
  pattern?: string            // solo para 'regex'
  message?: I18nString
}

// ─── Lógica condicional ──────────────────────────────────────

export type ConditionOperator = 'eq' | 'not_eq' | 'contains' | 'not_contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_empty' | 'is_not_empty' | 'in' | 'not_in'
export type LogicOperator = 'AND' | 'OR'

export interface ConditionRule {
  field: string               // id del campo a evaluar
  condition: ConditionOperator
  value?: string | number | string[]
}

export interface ConditionGroup {
  operator?: LogicOperator    // default: 'AND'
  rules: ConditionRule[]
}

// ─── Impacto en precio ───────────────────────────────────────

export type PricingImpactType = 'fixed_addon' | 'multiplier' | 'discount_pct' | 'discount_fixed'

export interface PricingImpact {
  type: PricingImpactType
  amount: number
  condition?: ConditionGroup  // aplicar solo si se cumple
}

// ─── Definición de campo ─────────────────────────────────────

export interface FieldDef {
  id: string                  // clave única, snake_case
  type: FieldType
  label: I18nString
  placeholder?: I18nString
  description?: I18nString    // texto de ayuda bajo el campo

  required?: boolean
  disabled?: boolean
  hidden?: boolean            // oculto por defecto (puede activarse por condición)

  // Lookup / dato maestro
  lookup_target?: boolean     // este campo dispara el lookup
  lookup_prefill?: JsonPath   // ruta en la respuesta del lookup para pre-llenar

  // Opciones (radio, checkbox, select)
  options?: FieldOption[]
  allow_other?: boolean       // opción "Otro: ____" libre

  // Número
  min?: number
  max?: number
  step?: number

  // Texto
  min_length?: number
  max_length?: number

  // Archivo
  accept?: string[]           // mime types, ej: ['image/jpeg', 'application/pdf']
  max_file_size_mb?: number

  // Acompañantes
  attendees_schema?: Omit<FieldDef, 'attendees_schema'>[]
  min_attendees?: number
  max_attendees?: number

  // Lógica
  validation?: Validation[]
  conditions?: ConditionGroup[]  // si se cumple algún grupo → visible
  pricing_impact?: PricingImpact

  // Metadatos del builder
  _section?: string           // agrupación visual en el builder
  _order?: number
}

// ─── Lookup Config ───────────────────────────────────────────

export interface LookupOnFound {
  prefill_fields: Record<string, JsonPath>   // fieldId → JsonPath en la respuesta
  assign_category?: JsonPath                  // JsonPath que da la categoría
  lock_prefilled?: boolean                    // deshabilitar edición de campos pre-llenados
  show_message?: I18nString
}

export interface LookupOnResume {
  redirect_to_step?: JsonPath
  show_message?: I18nString
  actions?: Array<'continue' | 'start_over'>
}

export interface LookupOnNotFound {
  show_message?: I18nString | null
  allow_new_registration?: boolean
}

export interface CategoryRule {
  if_category: string
  unlock_fields?: string[]
  hide_fields?: string[]
  set_field?: Record<string, string | number | boolean>
  hide_payment_block?: boolean
}

export interface LookupConfig {
  trigger_field: string       // id del campo dato maestro
  debounce_ms?: number        // default: 600
  endpoint: string            // ruta del backend, ej: '/api/lookup'
  method?: 'GET' | 'POST'
  headers?: Record<string, string>

  on_found?: LookupOnFound
  on_resume?: LookupOnResume
  on_not_found?: LookupOnNotFound
  category_rules?: CategoryRule[]
}

// ─── Pricing Config ──────────────────────────────────────────

export type PricingItemType =
  | 'field_value'        // el valor del campo es clave en un mapa de precios
  | 'addon_checkbox'     // checkbox que suma un monto
  | 'addon_number'       // campo numérico que multiplica un precio unitario
  | 'group_discount'     // descuento por cantidad (campo attendees)
  | 'category_discount'  // descuento/recargo por categoría del lookup
  | 'fixed'              // monto fijo siempre incluido

export interface PricingTier {
  min_qty: number
  max_qty?: number
  discount_pct?: number
  discount_fixed?: number
}

export interface PricingItem {
  id: string
  label: I18nString
  type: PricingItemType

  field?: string                          // campo que controla este item
  amount?: number                         // monto fijo
  unit_price?: number                     // precio por unidad (addon_number)
  options?: Record<string, number>        // mapa valor → precio (field_value)
  tiers?: PricingTier[]                   // escalas de descuento
  map?: Record<string, number>           // categoría → descuento (category_discount)
  source?: string                         // JsonPath fuente (category_discount)

  condition?: ConditionGroup             // aplicar solo si se cumple
  required?: boolean                     // no se puede deseleccionar
}

export interface TaxConfig {
  label: I18nString
  rate: number                            // 0.19 = 19%
  inclusive?: boolean                     // si el precio ya incluye el impuesto
}

export interface PricingConfig {
  currency: string                        // ISO 4217, ej: 'USD', 'COP'
  base_price: number
  items: PricingItem[]
  tax?: TaxConfig
}

// ─── Payment Config ──────────────────────────────────────────

export type PaymentProvider = 'stripe' | 'wompi' | 'paypal' | 'manual'
export type PaymentMethod = 'card' | 'pse' | 'oxxo' | 'bancolombia_transfer' | 'nequi' | 'daviplata' | 'paypal' | 'bank_transfer'

export interface StripeConfig {
  publishable_key: string
  payment_intent_endpoint: string         // endpoint del backend que crea el PaymentIntent
  on_success_redirect: string            // soporta {{submission_id}}
  on_cancel_redirect?: string
}

export interface ReceiptConfig {
  send_email?: boolean
  template_id?: string
  include_fields?: string[]
  cc?: string[]
}

export interface PaymentConfig {
  provider: PaymentProvider
  mode: 'live' | 'test'
  methods: PaymentMethod[]
  stripe?: StripeConfig
  receipt?: ReceiptConfig
}

// ─── Metadatos del formulario ─────────────────────────────────

export interface FormMeta {
  title: I18nString
  description?: I18nString
  logo_url?: string
  cover_image_url?: string
  primary_color?: string
  language?: string                       // default: 'es'
  custom_css?: string
}

// ─── Settings generales ──────────────────────────────────────

export interface FormSettings {
  max_submissions?: number
  opens_at?: ISODate
  closes_at?: ISODate
  allow_edit_after_submit?: boolean
  send_confirmation_email?: boolean
  confirmation_email_template?: string
  webhooks?: Array<{
    url: string
    events: Array<'submission.created' | 'submission.updated' | 'payment.completed'>
    headers?: Record<string, string>
  }>
}

// ─── Schema raíz del formulario ──────────────────────────────

export interface FormSchema {
  id: UUID
  version: number
  slug: string
  meta: FormMeta
  lookup?: LookupConfig
  fields: FieldDef[]
  pricing?: PricingConfig
  payment?: PaymentConfig
  settings?: FormSettings

  // Metadatos del sistema (no editables por el usuario)
  _created_at?: ISODate
  _updated_at?: ISODate
  _created_by?: UUID
  _status?: 'draft' | 'published' | 'archived'
}

// ─── Submission ──────────────────────────────────────────────

export type SubmissionStatus = 'in_progress' | 'pending_payment' | 'completed' | 'cancelled'

export interface Submission {
  id: UUID
  form_id: UUID
  form_version: number
  status: SubmissionStatus

  data: Record<string, unknown>           // valores de cada campo por su id
  lookup_result?: Record<string, unknown> // respuesta del lookup guardada
  assigned_category?: string

  pricing_snapshot?: {
    items: Array<{ id: string; label: string; amount: number }>
    subtotal: number
    tax?: number
    total: number
    currency: string
  }

  payment_intent_id?: string
  paid_at?: ISODate

  started_at: ISODate
  completed_at?: ISODate
  last_step?: number
  ip_address?: string
  user_agent?: string
}
