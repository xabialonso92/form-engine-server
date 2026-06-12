// =============================================================
// Form Engine — Core
// Procesa un FormSchema contra los datos del usuario en tiempo real.
// Determina qué campos son visibles, valida valores y calcula el precio.
// Corre en el SERVIDOR para validación final, y en el CLIENTE para UX.
// =============================================================

import type {
  FormSchema,
  FieldDef,
  ConditionGroup,
  ConditionRule,
  Validation,
  Submission,
} from '../schema/types'

export type FormData = Record<string, unknown>
export type FieldErrors = Record<string, string[]>

// ─── Estado del formulario evaluado ──────────────────────────

export interface EvaluatedForm {
  schema: FormSchema
  visibleFields: FieldDef[]    // campos que pasan sus condiciones
  errors: FieldErrors
  isValid: boolean
  data: FormData
}

// ─── Motor principal ──────────────────────────────────────────

export class FormEngine {
  constructor(private schema: FormSchema) {}

  // Evalúa el estado completo: qué es visible, qué errores hay
  evaluate(data: FormData): EvaluatedForm {
    const visibleFields = this.resolveVisibleFields(data)
    const errors = this.validateAll(visibleFields, data)
    const isValid = Object.keys(errors).length === 0

    return { schema: this.schema, visibleFields, errors, isValid, data }
  }

  // Evalúa solo un campo específico (para validación on-blur en el cliente)
  evaluateField(fieldId: string, data: FormData): string[] {
    const field = this.schema.fields.find(f => f.id === fieldId)
    if (!field) return []
    if (!this.isFieldVisible(field, data)) return []
    return this.validateField(field, data[fieldId], data)
  }

  // ─── Resolución de visibilidad ──────────────────────────────

  resolveVisibleFields(data: FormData): FieldDef[] {
    return this.schema.fields.filter(field => this.isFieldVisible(field, data))
  }

  isFieldVisible(field: FieldDef, data: FormData): boolean {
    if (field.hidden && !field.conditions) return false
    if (!field.conditions || field.conditions.length === 0) return true

    // Si hay grupos de condiciones, el campo es visible si AL MENOS UN grupo se cumple
    return field.conditions.some(group => this.evaluateConditionGroup(group, data))
  }

  private evaluateConditionGroup(group: ConditionGroup, data: FormData): boolean {
    const operator = group.operator ?? 'AND'
    if (operator === 'AND') {
      return group.rules.every(rule => this.evaluateRule(rule, data))
    }
    return group.rules.some(rule => this.evaluateRule(rule, data))
  }

  private evaluateRule(rule: ConditionRule, data: FormData): boolean {
    const value = data[rule.field]
    const target = rule.value

    switch (rule.condition) {
      case 'eq':          return String(value) === String(target)
      case 'not_eq':      return String(value) !== String(target)
      case 'contains':    return Array.isArray(value)
                            ? value.includes(target)
                            : String(value).includes(String(target))
      case 'not_contains':return Array.isArray(value)
                            ? !value.includes(target)
                            : !String(value).includes(String(target))
      case 'gt':          return Number(value) > Number(target)
      case 'gte':         return Number(value) >= Number(target)
      case 'lt':          return Number(value) < Number(target)
      case 'lte':         return Number(value) <= Number(target)
      case 'is_empty':    return value === undefined || value === null || value === ''
      case 'is_not_empty':return value !== undefined && value !== null && value !== ''
      case 'in':          return Array.isArray(target) && target.includes(value as string)
      case 'not_in':      return Array.isArray(target) && !target.includes(value as string)
      default:            return false
    }
  }

  // ─── Validación de campos ────────────────────────────────────

  private validateAll(fields: FieldDef[], data: FormData): FieldErrors {
    const errors: FieldErrors = {}
    for (const field of fields) {
      const fieldErrors = this.validateField(field, data[field.id], data)
      if (fieldErrors.length > 0) {
        errors[field.id] = fieldErrors
      }
    }
    return errors
  }

  validateField(field: FieldDef, value: unknown, data: FormData): string[] {
    const errors: string[] = []

    // Los campos de solo visualización no se validan
    if (field.type === 'divider' || field.type === 'heading' || field.type === 'payment') {
      return errors
    }

    // Validación required
    if (field.required && isEmpty(value)) {
      errors.push(resolveValidationMessage({ rule: 'required' }, field.label as string))
      return errors  // sin dato, no seguimos validando
    }

    // Si no es required y está vacío, saltar
    if (!field.required && isEmpty(value)) return errors

    // Validaciones declaradas en el schema
    for (const validation of field.validation ?? []) {
      const error = runValidation(validation, value, data)
      if (error) errors.push(error)
    }

    return errors
  }

  // ─── Serialización para guardar ─────────────────────────────

  // Extrae solo los datos de campos visibles (evita guardar datos de campos ocultos)
  sanitizeData(data: FormData): FormData {
    const visible = this.resolveVisibleFields(data)
    const result: FormData = {}
    for (const field of visible) {
      if (field.type === 'divider' || field.type === 'heading') continue
      if (data[field.id] !== undefined) {
        result[field.id] = data[field.id]
      }
    }
    return result
  }

  // Construye un objeto Submission parcial para persistir
  buildSubmission(data: FormData, submissionId: string, pricingSnapshot?: Submission['pricing_snapshot']): Partial<Submission> {
    const sanitized = this.sanitizeData(data)
    return {
      id: submissionId,
      form_id: this.schema.id,
      form_version: this.schema.version,
      status: pricingSnapshot ? 'pending_payment' : 'completed',
      data: sanitized,
      pricing_snapshot: pricingSnapshot,
      started_at: new Date().toISOString(),
    }
  }
}

// ─── Helpers de validación ────────────────────────────────────

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

function runValidation(validation: Validation, value: unknown, _data: FormData): string | null {
  const str = String(value ?? '')
  const num = Number(value)

  switch (validation.rule) {
    case 'email': {
      const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!re.test(str)) return validation.message as string ?? 'Ingresa un email válido'
      break
    }
    case 'phone': {
      const re = /^\+?[\d\s\-()]{7,20}$/
      if (!re.test(str)) return validation.message as string ?? 'Ingresa un teléfono válido'
      break
    }
    case 'url': {
      try { new URL(str) } catch { return validation.message as string ?? 'Ingresa una URL válida' }
      break
    }
    case 'min_length': {
      const min = Number(validation.value)
      if (str.length < min) return validation.message as string ?? `Mínimo ${min} caracteres`
      break
    }
    case 'max_length': {
      const max = Number(validation.value)
      if (str.length > max) return validation.message as string ?? `Máximo ${max} caracteres`
      break
    }
    case 'min': {
      if (num < Number(validation.value)) return validation.message as string ?? `El valor mínimo es ${validation.value}`
      break
    }
    case 'max': {
      if (num > Number(validation.value)) return validation.message as string ?? `El valor máximo es ${validation.value}`
      break
    }
    case 'regex': {
      if (!validation.pattern) break
      const re = new RegExp(validation.pattern)
      if (!re.test(str)) return validation.message as string ?? 'Formato inválido'
      break
    }
    case 'unique_submission':
      // Este se valida en el servidor — el cliente lo ignora
      break
  }
  return null
}

function resolveValidationMessage(validation: Validation, fieldLabel: string): string {
  if (validation.message) return validation.message as string
  return `${fieldLabel} es obligatorio`
}
