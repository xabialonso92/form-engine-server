// =============================================================
// Pricing Engine
// Calcula el total del registro a partir del schema de pricing
// y los datos actuales del formulario.
// Corre en cliente (preview en tiempo real) y servidor (fuente de verdad).
// =============================================================

import type {
  PricingConfig,
  PricingItem,
  Submission,
} from '../schema/types'

type FormData = Record<string, unknown>

export interface PricingLineItem {
  id: string
  label: string
  amount: number
  type: string
  qty?: number
}

export interface PricingResult {
  items: PricingLineItem[]
  subtotal: number
  tax_amount: number
  total: number
  currency: string
  // Para enviar a Stripe (en centavos/unidades mínimas)
  amount_for_stripe: number
}

// Monedas de cero decimales (Stripe no multiplica por 100)
const ZERO_DECIMAL_CURRENCIES = new Set(['CLP', 'JPY', 'KRW', 'PYG', 'UGX', 'VND'])

export class PricingEngine {
  constructor(
    private config: PricingConfig,
    private lookupCategory?: string,   // categoría del dato maestro
  ) {}

  calculate(data: FormData): PricingResult {
    const lineItems: PricingLineItem[] = []

    for (const item of this.config.items) {
      // Evaluar condición del item si existe
      if (item.condition && !this.evaluateCondition(item.condition, data)) {
        continue
      }

      const resolved = this.resolveItem(item, data)
      if (resolved !== null) {
        lineItems.push(resolved)
      }
    }

    const subtotal = lineItems.reduce((sum, i) => sum + i.amount, 0)
    const tax_amount = this.config.tax
      ? this.config.tax.inclusive
        ? subtotal - subtotal / (1 + this.config.tax.rate)
        : subtotal * this.config.tax.rate
      : 0

    const total = this.config.tax?.inclusive
      ? subtotal
      : subtotal + tax_amount

    const roundedTotal = Math.round(total * 100) / 100
    const roundedTax = Math.round(tax_amount * 100) / 100

    return {
      items: lineItems,
      subtotal: Math.round(subtotal * 100) / 100,
      tax_amount: roundedTax,
      total: roundedTotal,
      currency: this.config.currency,
      amount_for_stripe: toStripeAmount(roundedTotal, this.config.currency),
    }
  }

  private resolveItem(item: PricingItem, data: FormData): PricingLineItem | null {
    switch (item.type) {

      case 'fixed': {
        if ((item.amount ?? 0) === 0) return null
        return { id: item.id, label: item.label as string, amount: item.amount!, type: 'fixed' }
      }

      case 'field_value': {
        if (!item.field || !item.options) return null
        const val = String(data[item.field] ?? '')
        const price = item.options[val]
        if (price === undefined) return null
        return { id: item.id, label: item.label as string, amount: price, type: 'field_value' }
      }

      case 'addon_checkbox': {
        if (!item.field || !item.amount) return null
        const checked = Boolean(data[item.field])
        if (!checked) return null
        return { id: item.id, label: item.label as string, amount: item.amount, type: 'addon' }
      }

      case 'addon_number': {
        if (!item.field || !item.unit_price) return null
        const qty = Number(data[item.field] ?? 0)
        if (qty <= 0) return null
        return {
          id: item.id,
          label: item.label as string,
          amount: qty * item.unit_price,
          type: 'addon',
          qty,
        }
      }

      case 'group_discount': {
        if (!item.field || !item.tiers) return null

        // Contar cantidad de acompañantes + el inscrito principal
        const attendees = data[item.field]
        const qty = Array.isArray(attendees) ? attendees.length + 1 : 1
        if (qty < 2) return null

        // Encontrar el tier más alto que aplica
        const tier = [...item.tiers]
          .sort((a, b) => b.min_qty - a.min_qty)
          .find(t => qty >= t.min_qty)
        if (!tier) return null

        // Calcular el subtotal ANTES de este descuento
        const preDiscountTotal = this.calculatePreDiscount(data)

        let discountAmount = 0
        if (tier.discount_pct) {
          discountAmount = -Math.round(preDiscountTotal * (tier.discount_pct / 100) * 100) / 100
        } else if (tier.discount_fixed) {
          discountAmount = -tier.discount_fixed
        }

        if (discountAmount === 0) return null
        return {
          id: item.id,
          label: `${item.label} (${qty} personas)` as string,
          amount: discountAmount,
          type: 'discount',
          qty,
        }
      }

      case 'category_discount': {
        if (!this.lookupCategory || !item.map) return null
        const discount = item.map[this.lookupCategory]
        if (discount === undefined || discount === 0) return null
        return {
          id: item.id,
          label: item.label as string,
          amount: -Math.abs(discount),
          type: 'discount',
        }
      }

      default:
        return null
    }
  }

  // Calcula el subtotal sin descuentos para base de cálculo porcentual
  private calculatePreDiscount(data: FormData): number {
    let total = 0
    for (const item of this.config.items) {
      if (['group_discount', 'category_discount'].includes(item.type)) continue
      if (item.condition && !this.evaluateCondition(item.condition, data)) continue
      const resolved = this.resolveItem(item, data)
      if (resolved && resolved.amount > 0) total += resolved.amount
    }
    return total
  }

  private evaluateCondition(condition: PricingItem['condition'], data: FormData): boolean {
    if (!condition) return true
    const op = condition.operator ?? 'AND'
    const eval_ = (rule: { field: string; condition: string; value?: unknown }) => {
      const val = data[rule.field]
      switch (rule.condition) {
        case 'eq':     return String(val) === String(rule.value)
        case 'not_eq': return String(val) !== String(rule.value)
        default:       return true
      }
    }
    return op === 'AND'
      ? condition.rules.every(eval_)
      : condition.rules.some(eval_)
  }
}

// ─── Conversión a unidades de Stripe ─────────────────────────

function toStripeAmount(amount: number, currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())) {
    return Math.round(amount)
  }
  return Math.round(amount * 100)
}

// ─── Snapshot para Submission ─────────────────────────────────

export function buildPricingSnapshot(
  result: PricingResult,
): Submission['pricing_snapshot'] {
  return {
    items: result.items.map(i => ({
      id: i.id,
      label: i.label,
      amount: i.amount,
    })),
    subtotal: result.subtotal,
    tax: result.tax_amount > 0 ? result.tax_amount : undefined,
    total: result.total,
    currency: result.currency,
  }
}
