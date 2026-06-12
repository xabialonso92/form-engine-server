// =============================================================
// Stripe Adapter
// =============================================================

import Stripe from 'stripe'

let stripeClient: Stripe | null = null

function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) throw new Error('STRIPE_SECRET_KEY no definida')
    stripeClient = new Stripe(key, { apiVersion: '2024-04-10' })
  }
  return stripeClient
}

export const stripeAdapter = {
  async createPaymentIntent(params: {
    amount: number
    currency: string
    metadata: Record<string, string>
  }): Promise<{ client_secret: string; id: string }> {
    const intent = await getStripe().paymentIntents.create({
      amount:   params.amount,
      currency: params.currency,
      metadata: params.metadata,
      automatic_payment_methods: { enabled: true },
    })

    if (!intent.client_secret) {
      throw new Error('Stripe no devolvió client_secret')
    }

    return { client_secret: intent.client_secret, id: intent.id }
  },

  async confirmPaymentIntentPaid(paymentIntentId: string): Promise<boolean> {
    const intent = await getStripe().paymentIntents.retrieve(paymentIntentId)
    return intent.status === 'succeeded'
  },

  // Verificar firma del webhook de Stripe
  constructWebhookEvent(payload: Buffer, sig: string): Stripe.Event {
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET no definida')
    return getStripe().webhooks.constructEvent(payload, sig, secret)
  },
}
