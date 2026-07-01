// Multi-conversation chat history, persisted to localStorage.
//
// Shape: [{ id, title, messages, createdAt, updatedAt }] plus a separate "active id".
// Migrates the legacy single `chatHistory` key into one conversation on first load.

const CONV_KEY = 'conversations'
const ACTIVE_KEY = 'activeConversationId'

export function titleFromMessages(messages) {
  const firstUser = (messages || []).find(
    (m) => m.role === 'user' && m.content && m.content.trim()
  )
  if (!firstUser) return ''
  return firstUser.content.trim().replace(/\s+/g, ' ').slice(0, 40)
}

export function newConversation(messages = []) {
  return {
    id: Date.now() + Math.floor(Math.random() * 1000),
    title: titleFromMessages(messages) || 'New chat',
    messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export function loadConversations() {
  try {
    const raw = localStorage.getItem(CONV_KEY)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr) && arr.length) return arr
    }
    // Migrate the old single-history key, if present.
    const old = localStorage.getItem('chatHistory')
    const msgs = old ? JSON.parse(old) : []
    return [newConversation(Array.isArray(msgs) ? msgs : [])]
  } catch {
    return [newConversation([])]
  }
}

export function saveConversations(convs) {
  try {
    localStorage.setItem(CONV_KEY, JSON.stringify(convs))
  } catch {
    /* quota / disabled — ignore */
  }
}

export function loadActiveId(convs) {
  try {
    const id = localStorage.getItem(ACTIVE_KEY)
    const match = convs.find((c) => String(c.id) === String(id))
    if (match) return match.id
  } catch {
    /* ignore */
  }
  return convs[0]?.id
}

export function saveActiveId(id) {
  try {
    localStorage.setItem(ACTIVE_KEY, String(id))
  } catch {
    /* ignore */
  }
}
