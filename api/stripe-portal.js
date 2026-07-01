// Opens Stripe's hosted Customer Portal (cancel, update card, view invoices) for the
// signed-in user's existing subscription.

import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const SUPABASE_URL = 'https://boleszqdqphfxxwizyoo.supabase.co'
const supabaseAdmin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Sign in required.' })

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token)
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Sign in required.' })

  const { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', userData.user.id)
    .maybeSingle()

  if (!sub?.stripe_customer_id) return res.status(400).json({ error: 'No billing account yet — upgrade first.' })

  const origin = req.headers.origin || `https://${req.headers.host}`
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: origin,
    })
    res.status(200).json({ url: portal.url })
  } catch (err) {
    console.error('Portal session failed:', err.message)
    res.status(500).json({ error: 'Could not open billing portal.' })
  }
}
