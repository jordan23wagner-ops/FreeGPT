// Lightweight client-side usage tracking so we can warn before hitting free-tier
// limits. This is a UX nudge only, trivially bypassed (incognito, clearing storage) —
// it is NOT what protects the shared Ollama key from abuse. Real enforcement is
// server-side in api/chat.js (generation-time based, per-identity + a global daily
// ceiling across all users), which this client-side number should stay roughly under
// so a well-behaved user rarely sees the server-side rejection. Counts reset each
// calendar day.

const KEY = 'usageStats'

// Conservative soft ceilings (see HANDOFF "Usage & Limits"). We warn early so a long
// chat session doesn't get throttled mid-conversation.
export const IMAGE_DAILY_SOFT_LIMIT = 25
export const CHAT_DAILY_SOFT_LIMIT = 400

// ---- Free vs Pro tiers ----
// The $5/mo Pro plan lifts the daily message cap. Both numbers are internal safety
// ceilings, not a capacity guarantee: the backend is one shared Ollama Cloud free-tier
// key across every visitor, GPU-time-quota'd (not request-count-quota'd), so don't
// surface PRO_DAILY_MESSAGE_LIMIT verbatim in UI copy — say "higher limit" instead.
// FREE_DAILY_MESSAGE_LIMIT is deliberately generous (most free competitors are
// effectively uncapped) — it exists as a last-resort circuit breaker for the shared
// key, not as the actual usage-shaping mechanism, so it shouldn't feel like a wall.
export const FREE_DAILY_MESSAGE_LIMIT = 150
export const PRO_DAILY_MESSAGE_LIMIT = 2000

// Returns the user's daily message allowance for their plan.
export function dailyMessageLimit(isPro = false) {
  return isPro ? PRO_DAILY_MESSAGE_LIMIT : FREE_DAILY_MESSAGE_LIMIT
}

// True when the user has hit their plan's daily message cap.
export function overMessageLimit(usage, isPro = false) {
  return (usage?.chat || 0) >= dailyMessageLimit(isPro)
}

// ---- Context window (rough estimate) ----
// All current models run with roughly a 128k-token context window. There's no real
// tokenizer on the client, so we estimate tokens as chars/4 (a standard rough
// heuristic) — good enough to warn a user before a very long chat degrades quality.
export const CONTEXT_WINDOW_TOKENS = 128000

// Fraction (0-1) of the context window the current conversation is estimated to use.
export function contextUsageRatio(messages = [], extraChars = 0) {
  const chars = messages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0) + extraChars
  const tokens = Math.ceil(chars / 4)
  return Math.min(1, tokens / CONTEXT_WINDOW_TOKENS)
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

export function loadUsage() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    if (raw.date !== today()) return { date: today(), chat: 0, image: 0 }
    return { date: raw.date, chat: raw.chat || 0, image: raw.image || 0 }
  } catch {
    return { date: today(), chat: 0, image: 0 }
  }
}

export function bumpUsage({ chat = 0, image = 0 }) {
  const u = loadUsage()
  u.chat += chat
  u.image += image
  try {
    localStorage.setItem(KEY, JSON.stringify(u))
  } catch {
    /* ignore */
  }
  return u
}
