// Auth layer for Chatwillow — thin wrapper over Supabase Auth.
//
// Signed out  → app works on localStorage only (private to the browser).
// Signed in   → cloud sync/memory/shares activate, scoped to auth.uid() by RLS.
//
// Two sign-in methods: passwordless email magic-link and Google OAuth. Both are
// no-ops (resolve to an error) when Supabase isn't configured yet.

import { supabase, hasSupabase } from './supabase'

// Current user id (uuid) or null. Used to key per-user rows (e.g. user_settings).
let cachedUserId = null

export function currentUserId() {
  return cachedUserId
}

export function isSignedIn() {
  return !!cachedUserId
}

// Resolve the active session once on startup.
export async function initAuth() {
  if (!hasSupabase) return null
  const { data } = await supabase.auth.getSession()
  cachedUserId = data?.session?.user?.id || null
  return data?.session?.user || null
}

// Subscribe to auth changes. Calls cb(user|null) on sign-in / sign-out / refresh.
export function onAuthChange(cb) {
  if (!hasSupabase) return () => {}
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    cachedUserId = session?.user?.id || null
    cb(session?.user || null)
  })
  return () => data?.subscription?.unsubscribe()
}

// Passwordless email — sends a magic link / OTP to the address. The user clicks
// it and lands back on the app already signed in.
export async function signInWithEmail(email) {
  if (!hasSupabase) return { error: 'Accounts are not configured yet.' }
  const { error } = await supabase.auth.signInWithOtp({
    email: String(email || '').trim(),
    options: { emailRedirectTo: window.location.origin },
  })
  return { error: error?.message || null }
}

// Google OAuth — redirects out to Google and back.
export async function signInWithGoogle() {
  if (!hasSupabase) return { error: 'Accounts are not configured yet.' }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  })
  return { error: error?.message || null }
}

export async function signOut() {
  if (!hasSupabase) return
  await supabase.auth.signOut()
  cachedUserId = null
}

export async function currentUser() {
  if (!hasSupabase) return null
  const { data } = await supabase.auth.getUser()
  return data?.user || null
}
