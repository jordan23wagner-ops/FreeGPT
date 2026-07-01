// Phase 7 — Shareable links. Write a frozen snapshot of a conversation to the
// `shared_chats` table under an unguessable id (the link's access token), and read it
// back for the read-only viewer. No keys, no live data — just the messages.

import { supabase, hasSupabase } from './supabase'
import { isSignedIn } from './auth'

const cloudReady = () => hasSupabase && isSignedIn()

// Unguessable share slug. 16 random bytes → base36, ~24 chars.
function slug() {
  const bytes = new Uint8Array(16)
  window.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24)
}

// Strip heavy/transient fields so snapshot rows stay small and safe to make public:
// drop base64 images (data: URLs) and the full RAG document text (docText). Keep what a
// reader actually needs — role, content, the doc's name, and any hosted image URL.
function slimMessages(messages) {
  return (messages || [])
    .filter((m) => m && (m.content || m.image || (m.images && m.images.length) || m.docName))
    .map((m) => {
      const out = { role: m.role, content: m.content || '' }
      // Uploaded photos are data: URLs — never published; just signal one was here.
      if ((m.images && m.images.length) || (m.image && String(m.image).startsWith('data:'))) {
        out.imageOmitted = true
      } else if (m.image) {
        out.image = m.image // hosted (non-data) URL is safe to keep
      }
      if (m.docName) out.docName = m.docName
      return out
    })
}

// Create a share. Returns the slug id, or throws on failure.
export async function createShare(conv) {
  if (!cloudReady()) throw new Error('Sign in to create a shareable link.')
  const id = slug()
  const row = {
    id,
    title: (conv?.title || 'Shared chat').slice(0, 120),
    messages: slimMessages(conv?.messages),
    created_at: Date.now(),
  }
  const { error } = await supabase.from('shared_chats').insert(row)
  if (error) throw new Error(error.message || 'Could not create share link.')
  return id
}

// Fetch a shared snapshot by id, or null if it doesn't exist.
export async function loadShare(id) {
  if (!id || !hasSupabase) return null
  const { data, error } = await supabase
    .from('shared_chats').select('id, title, messages, created_at').eq('id', id).single()
  if (error || !data) return null
  return data
}

// List existing shares (newest first) for the manage/revoke UI. Skips `messages` so the
// list stays light. Returns [] on any error (e.g. the share table migration not run).
export async function listShares() {
  if (!cloudReady()) return []
  const { data, error } = await supabase
    .from('shared_chats').select('id, title, created_at').order('created_at', { ascending: false })
  if (error || !data) return []
  return data
}

// Permanently revoke a share by id. Returns true on success. After this the ?s=<id> link
// 404s in the read-only viewer (loadShare returns null).
export async function deleteShare(id) {
  if (!id || !cloudReady()) return false
  const { error } = await supabase.from('shared_chats').delete().eq('id', id)
  return !error
}

// Build the absolute link for a slug, preserving the current origin + path.
export function shareUrl(id) {
  return `${window.location.origin}${window.location.pathname}?s=${id}`
}

// Read the share id from the current URL (?s=<id>), if any.
export function shareIdFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get('s')
  } catch {
    return null
  }
}
