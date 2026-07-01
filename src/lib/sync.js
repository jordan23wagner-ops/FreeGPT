// Cloud sync layer (signed-in users only).
//
// Signed out → these are no-ops; localStorage is the sole store (private to the
// browser). Signed in → conversations back up to Supabase, scoped to auth.uid()
// by RLS. The browser-minted conversation id rides along as `client_id` (it's
// only unique per user), so we upsert on (user_id, client_id).
//
// Strategy:
//   Load  → fetch the user's rows from Supabase, merge with localStorage (latest wins)
//   Save  → write localStorage immediately, then async push to Supabase

import { supabase, hasSupabase } from './supabase'
import { isSignedIn } from './auth'

const cloudReady = () => hasSupabase && isSignedIn()

// ---- Conversations ----

export async function syncConversationsDown(localConvs) {
  if (!cloudReady()) return localConvs

  try {
    // RLS already restricts this to the signed-in user's rows.
    const { data, error } = await supabase
      .from('conversations')
      .select('client_id, title, messages, created_at, updated_at')
      .order('updated_at', { ascending: false })

    if (error) { console.warn('Supabase conversations fetch failed:', error.message); return localConvs }
    if (!data || data.length === 0) return localConvs

    const remoteMap = new Map(data.map((r) => [r.client_id, {
      id: r.client_id,
      title: r.title,
      messages: r.messages,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }]))

    const localMap = new Map((localConvs || []).map((c) => [c.id, c]))

    // Merge: for each conversation, keep whichever version has the later updatedAt.
    const allIds = new Set([...remoteMap.keys(), ...localMap.keys()])
    const merged = []
    for (const id of allIds) {
      const remote = remoteMap.get(id)
      const local = localMap.get(id)
      if (remote && local) {
        merged.push((remote.updatedAt || 0) >= (local.updatedAt || 0) ? remote : local)
      } else {
        merged.push(remote || local)
      }
    }

    merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return merged
  } catch (err) {
    console.warn('Supabase sync down failed:', err.message)
    return localConvs
  }
}

export async function syncConversationUp(conv) {
  if (!cloudReady() || !conv) return

  try {
    // user_id is stamped by the column default (auth.uid()); never sent from the client.
    await supabase.from('conversations').upsert({
      client_id: String(conv.id),
      title: conv.title || 'New chat',
      messages: conv.messages || [],
      created_at: conv.createdAt || Date.now(),
      updated_at: conv.updatedAt || Date.now(),
    }, { onConflict: 'user_id,client_id' })
  } catch (err) {
    console.warn('Supabase conversation push failed:', err.message)
  }
}

export async function syncDeleteConversation(id) {
  if (!cloudReady()) return
  try {
    await supabase.from('conversations').delete().eq('client_id', String(id))
  } catch (err) {
    console.warn('Supabase conversation delete failed:', err.message)
  }
}
