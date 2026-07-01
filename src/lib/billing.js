// Stripe billing — Checkout redirect to upgrade, Customer Portal to manage/cancel.
// Both API calls are authenticated with the signed-in user's Supabase access token.

import { supabase, hasSupabase } from './supabase'

async function accessToken() {
  if (!hasSupabase) return null
  const { data } = await supabase.auth.getSession()
  return data?.session?.access_token || null
}

async function postJson(path) {
  const token = await accessToken()
  if (!token) throw new Error('Sign in first.')
  const res = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Request failed.')
  return data
}

export async function startCheckout() {
  const { url } = await postJson('/api/stripe-checkout')
  window.location.href = url
}

export async function openBillingPortal() {
  const { url } = await postJson('/api/stripe-portal')
  window.location.href = url
}

// The signed-in user's own subscription row — RLS scopes this to auth.uid(), so no
// explicit user_id filter is needed (or possible to bypass) from the client.
export async function fetchMySubscription() {
  if (!hasSupabase) return null
  const { data } = await supabase.from('subscriptions').select('plan, status, current_period_end').maybeSingle()
  return data || null
}

export function isProPlan(sub) {
  return !!sub && sub.plan === 'pro' && (sub.status === 'active' || sub.status === 'trialing')
}
