// Supabase client for FreeGPT (public, multi-user).
//
// The anon/publishable key is meant to ship in frontend code (like Stripe's
// publishable key). Security comes from Row Level Security policies + Supabase
// Auth, NOT from hiding this key — every table is scoped to auth.uid().
//
// SETUP: create a FRESH Supabase project for the public app (do NOT reuse a
// private project) and paste its Project URL + anon (publishable) key below.
// Until both are filled in, `hasSupabase` is false and the app runs in
// localStorage-only mode (still fully usable, just no cloud sync/accounts).

import { createClient } from '@supabase/supabase-js'

const url = 'https://boleszqdqphfxxwizyoo.supabase.co'
const key = 'sb_publishable_i_JpTN1VMvgByGCL3KPNQQ_7PpYGzhb'

// Treat the placeholders as "not configured" so the app degrades gracefully.
const configured = !url.includes('YOUR_PROJECT_REF') && !key.includes('YOUR_SUPABASE_ANON_KEY')

export const hasSupabase = configured

// Persist the session so users stay logged in across reloads/devices.
export const supabase = configured
  ? createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null
