// Stripe webhook — keeps the `subscriptions` table in sync with Stripe as the source
// of truth for plan/status. Signature verification needs the exact raw request bytes,
// so body parsing is disabled and we read the stream ourselves.

import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const config = { api: { bodyParser: false } }

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const SUPABASE_URL = 'https://boleszqdqphfxxwizyoo.supabase.co'
const supabaseAdmin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function lookupUserByCustomer(customerId) {
  const { data } = await supabaseAdmin
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()
  return data?.user_id || null
}

async function upsertFromSubscription(sub) {
  const userId = sub.metadata?.supabase_user_id || (await lookupUserByCustomer(sub.customer))
  if (!userId) {
    console.error('Webhook: no Supabase user for Stripe subscription', sub.id)
    return
  }
  const plan = ['active', 'trialing'].includes(sub.status) ? 'pro' : 'free'
  await supabaseAdmin.from('subscriptions').upsert(
    {
      user_id: userId,
      plan,
      status: sub.status,
      stripe_customer_id: sub.customer,
      current_period_end: sub.current_period_end ? sub.current_period_end * 1000 : null,
      updated_at: Date.now(),
    },
    { onConflict: 'user_id' }
  )
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  let event
  try {
    const raw = await readRawBody(req)
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        if (session.mode === 'subscription' && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription)
          await upsertFromSubscription(sub)
        }
        break
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await upsertFromSubscription(event.data.object)
        break
      default:
        break
    }
    res.status(200).json({ received: true })
  } catch (err) {
    console.error('Webhook handler failed:', err.message)
    res.status(500).json({ error: 'handler failed' })
  }
}
