// =============================================================
// Form Engine — Schema Validator
// Valida coherencia interna del schema antes de guardarlo/publicarlo
// =============================================================

import type {
  FormSchema,
  FieldDef,
  ConditionGroup,
  PricingConfig,
  LookupConfig,
} from './types'

export interface ValidationError {
  path: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationError[]
}

// ─── Validador principal ──────────────────────────────────────

export function validateSchema(schema: FormSchema): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationError[] = []
  const fieldIds = new Set<string>()

  // Raíz
  if (!schema.id)      errors.push({ path: 'id',      message: 'El formulario debe tener un id único' })
  if (!schema.slug)    errors.push({ path: 'slug',    message: 'El slug es obligatorio' })
  if (!schema.version) errors.push({ path: 'version', message: 'La versión es obligatoria' })
  if (!schema.meta?.title) errors.push({ path: 'meta.title', message: 'El formulario debe tener un título' })

  // Slug: solo letras, números y guiones
  if (schema.slug && !/^[a-z0-9-]+$/.test(schema.slug)) {
    errors.push({ path: 'slug', message: 'El slug solo puede contener letras minúsculas, números y guiones' })
  }

  // Campos
  if (!schema.fields || schema.fields.length === 0) {
    errors.push({ path: 'fields', message: 'El formulario debe tener al menos un campo' })
  }

  for (const [i, field] of (schema.fields ?? []).entries()) {
    const prefix = `fields[${i}]`
    validateField(field, prefix, fieldIds, errors, warnings)
  }

  // Lookup
  if (schema.lookup) {
    validateLookup(schema.lookup, schema.fields ?? [], errors)
  }

  // Pricing
  if (schema.pricing) {
    validatePricing(schema.pricing, schema.fields ?? [], errors, warnings)
  }

  // Condiciones — referencian campos que existen
  for (const [i, field] of (schema.fields ?? []).entries()) {
    if (field.conditions) {
      for (const group of field.conditions) {
        for (const rule of group.rules) {
          if (!fieldIds.has(rule.field)) {
            errors.push({
              path: `fields[${i}].conditions`,
              message: `La condición referencia el campo "${rule.field}" que no existe`,
            })
          }
        }
      }
    }
  }

  // Payment
  if (schema.payment) {
    if (schema.payment.provider === 'stripe' && !schema.payment.stripe?.payment_intent_endpoint) {
      errors.push({ path: 'payment.stripe', message: 'Stripe requiere el endpoint para crear PaymentIntents' })
    }
    const hasPaymentField = schema.fields?.some(f => f.type === 'payment')
    if (!hasPaymentField) {
      warnings.push({ path: 'payment', message: 'Hay configuración de pago pero no hay campo de tipo "payment" en el formulario' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

// ─── Validación de campo individual ──────────────────────────

function validateField(
  field: FieldDef,
  prefix: string,
  fieldIds: Set<string>,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  if (!field.id) {
    errors.push({ path: prefix, message: 'Cada campo debe tener un id único' })
    return
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(field.id)) {
    errors.push({ path: `${prefix}.id`, message: `El id "${field.id}" debe ser snake_case (letras minúsculas, números y guiones bajos)` })
  }
  if (fieldIds.has(field.id)) {
    errors.push({ path: `${prefix}.id`, message: `El id "${field.id}" está duplicado` })
  }
  fieldIds.add(field.id)

  if (!field.type) {
    errors.push({ path: `${prefix}.type`, message: 'El campo debe tener un tipo' })
  }
  if (!field.label) {
    errors.push({ path: `${prefix}.label`, message: 'El campo debe tener una etiqueta' })
  }

  const TYPES_WITH_OPTIONS = ['radio', 'checkbox', 'select']
  if (TYPES_WITH_OPTIONS.includes(field.type)) {
    if (!field.options || field.options.length === 0) {
      errors.push({ path: `${prefix}.options`, message: `El campo tipo "${field.type}" requiere al menos una opción` })
    } else {
      const optValues = new Set<string>()
      for (const opt of field.options) {
        if (!opt.value) errors.push({ path: `${prefix}.options`, message: 'Cada opción debe tener un valor' })
        if (optValues.has(opt.value)) {
          errors.push({ path: `${prefix}.options`, message: `El valor de opción "${opt.value}" está duplicado` })
        }
        optValues.add(opt.value)
      }
    }
  }

  if (field.type === 'attendees' && !field.attendees_schema) {
    warnings.push({ path: `${prefix}.attendees_schema`, message: 'Campo de acompañantes sin schema definido' })
  }

  if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
    errors.push({ path: `${prefix}`, message: 'El valor mínimo no puede ser mayor al máximo' })
  }

  if (field.type === 'payment' && field.required) {
    warnings.push({ path: `${prefix}.required`, message: 'El campo "payment" no usa la propiedad required — el pago se controla desde PaymentConfig' })
  }
}

// ─── Validación del Lookup ────────────────────────────────────

function validateLookup(
  lookup: LookupConfig,
  fields: FieldDef[],
  errors: ValidationError[],
): void {
  if (!lookup.trigger_field) {
    errors.push({ path: 'lookup.trigger_field', message: 'El lookup debe especificar el campo que lo dispara' })
    return
  }

  const triggerField = fields.find(f => f.id === lookup.trigger_field)
  if (!triggerField) {
    errors.push({ path: 'lookup.trigger_field', message: `El campo "${lookup.trigger_field}" no existe en el formulario` })
    return
  }

  if (!triggerField.lookup_target) {
    errors.push({
      path: 'lookup.trigger_field',
      message: `El campo "${lookup.trigger_field}" debe tener lookup_target: true`,
    })
  }

  if (!lookup.endpoint) {
    errors.push({ path: 'lookup.endpoint', message: 'El lookup requiere un endpoint' })
  }

  // Verificar que los campos de prefill existen
  if (lookup.on_found?.prefill_fields) {
    for (const fieldId of Object.keys(lookup.on_found.prefill_fields)) {
      if (!fields.find(f => f.id === fieldId)) {
        errors.push({
          path: 'lookup.on_found.prefill_fields',
          message: `prefill_fields referencia "${fieldId}" que no existe en el formulario`,
        })
      }
    }
  }
}

// ─── Validación del Pricing ───────────────────────────────────

function validatePricing(
  pricing: PricingConfig,
  fields: FieldDef[],
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  if (!pricing.currency) {
    errors.push({ path: 'pricing.currency', message: 'La configuración de precios requiere moneda (ISO 4217)' })
  }

  if (pricing.tax) {
    if (pricing.tax.rate < 0 || pricing.tax.rate > 1) {
      errors.push({ path: 'pricing.tax.rate', message: 'La tasa de impuesto debe estar entre 0 y 1 (ej: 0.19 para 19%)' })
    }
  }

  const itemIds = new Set<string>()
  for (const [i, item] of pricing.items.entries()) {
    const prefix = `pricing.items[${i}]`

    if (!item.id) {
      errors.push({ path: prefix, message: 'Cada item de pricing debe tener un id' })
    }
    if (itemIds.has(item.id)) {
      errors.push({ path: prefix, message: `El id de pricing "${item.id}" está duplicado` })
    }
    itemIds.add(item.id)

    if (item.field && !fields.find(f => f.id === item.field)) {
      errors.push({ path: `${prefix}.field`, message: `El campo "${item.field}" referenciado en pricing no existe` })
    }

    if (item.type === 'field_value' && (!item.options || Object.keys(item.options).length === 0)) {
      warnings.push({ path: `${prefix}.options`, message: 'Item de tipo field_value sin mapa de precios definido' })
    }

    if (item.type === 'group_discount' && (!item.tiers || item.tiers.length === 0)) {
      errors.push({ path: `${prefix}.tiers`, message: 'El descuento grupal requiere al menos un tier' })
    }
  }
}

// ─── Utilidad: resolución de I18nString ──────────────────────

export function resolveI18n(value: string | Record<string, string>, lang = 'es'): string {
  if (typeof value === 'string') return value
  return value[lang] ?? value['es'] ?? Object.values(value)[0] ?? ''
}
