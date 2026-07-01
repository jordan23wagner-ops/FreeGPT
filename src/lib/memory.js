// Semantic memory on Supabase pgvector — a faithful port of mcp-memory-server's
// store.py. Same constants and reranking so behavior matches the original:
//   - dedup when nearest cosine distance <= 0.05 (update instead of insert)
//   - retrieval reranks fetched candidates by  (1 - distance) - 0.01 * age_days
//   - fetch top_k*3 candidates, return top_k

import { supabase, hasSupabase } from './supabase'
import { isSignedIn, currentUserId } from './auth'
import { embed } from './embed'

const RECENCY_DECAY_WEIGHT = 0.01
const DUPLICATE_DISTANCE_THRESHOLD = 0.05

// Cloud memory is a feature of the app, but only active for signed-in users
// (RLS scopes every row to auth.uid()). Signed-out callers get clean no-ops.
export const memoryAvailable = hasSupabase
const cloudReady = () => hasSupabase && isSignedIn()

// Store a memory. Embeds the text, and if a near-duplicate exists (distance <= 0.05)
// updates it in place rather than inserting a new row.
export async function storeMemory(text, { category = 'general', source = 'chat' } = {}) {
  const clean = String(text || '').trim()
  if (!cloudReady() || clean.length < 4) return null
  try {
    const embedding = await embed(clean)
    const now = Date.now()

    // Dedup: find the single nearest existing memory.
    const { data: nearest } = await supabase.rpc('match_memories', {
      query_embedding: embedding,
      match_count: 1,
    })
    if (nearest && nearest[0] && nearest[0].distance <= DUPLICATE_DISTANCE_THRESHOLD) {
      await supabase.from('memories').update({
        text: clean, category, source, embedding, updated_at: now,
      }).eq('id', nearest[0].id)
      return nearest[0].id
    }

    const { data, error } = await supabase.from('memories').insert({
      text: clean, summary: '', category, source, embedding,
      created_at: now, updated_at: now,
    }).select('id').single()
    if (error) { console.warn('storeMemory insert failed:', error.message); return null }
    return data.id
  } catch (err) {
    console.warn('storeMemory failed:', err.message)
    return null
  }
}

// Retrieve the topK most relevant memories for a query, recency-reranked.
export async function retrieveMemories(query, topK = 5) {
  if (!cloudReady()) return []
  try {
    const embedding = await embed(query)
    const { data, error } = await supabase.rpc('match_memories', {
      query_embedding: embedding,
      match_count: Math.min(topK * 3, 30),
    })
    if (error || !Array.isArray(data)) return []

    const now = Date.now()
    const scored = data.map((m) => {
      const similarity = 1 - (m.distance || 0)
      const ageDays = m.created_at ? (now - m.created_at) / 86400000 : 0
      return { score: similarity - RECENCY_DECAY_WEIGHT * ageDays, mem: m }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK).map((s) => s.mem)
  } catch (err) {
    console.warn('retrieveMemories failed:', err.message)
    return []
  }
}

export async function listMemories() {
  if (!cloudReady()) return []
  const { data } = await supabase
    .from('memories')
    .select('id, text, category, source, created_at')
    .order('created_at', { ascending: false })
    .limit(200)
  return data || []
}

export async function deleteMemory(id) {
  if (!cloudReady()) return
  await supabase.from('memories').delete().eq('id', id)
}

// ---- Per-user settings (custom instructions / about you / memory toggle) ----

export async function loadSettings() {
  if (!cloudReady()) return null
  // RLS restricts this to the caller's own row; user_id is the primary key.
  const { data } = await supabase.from('user_settings').select('*').limit(1).maybeSingle()
  return data || null
}

export async function saveSettings({ about_you, custom_instructions, memory_enabled }) {
  if (!cloudReady()) return
  await supabase.from('user_settings').upsert({
    user_id: currentUserId(), about_you, custom_instructions, memory_enabled, updated_at: Date.now(),
  }, { onConflict: 'user_id' })
}
