// Lightweight client-side usage tracking so we can warn before hitting free-tier
// limits — NVIDIA's image credits are the real cap. Counts reset each calendar day.

const KEY = 'usageStats'

// Conservative soft ceilings (see HANDOFF "Usage & Limits"). We warn early so a long
// chat session doesn't get throttled mid-conversation.
export const IMAGE_DAILY_SOFT_LIMIT = 25
export const CHAT_DAILY_SOFT_LIMIT = 400

// ---- Free vs Pro tiers ----
// The $5/mo Pro plan (Phase 2, Stripe) lifts the daily message cap. Until billing
// ships, isPro() is always false and every user is on the free tier. Keep the free
// limit generous so the cap is a gentle nudge, not a wall, during the traffic-growth
// phase. When Stripe lands, isPro reads the user's subscription row.
export const FREE_DAILY_MESSAGE_LIMIT = 50
export const PRO_DAILY_MESSAGE_LIMIT = 2000

// Returns the user's daily message allowance for their plan.
export function dailyMessageLimit(isPro = false) {
  return isPro ? PRO_DAILY_MESSAGE_LIMIT : FREE_DAILY_MESSAGE_LIMIT
}

// True when the user has hit their plan's daily message cap.
export function overMessageLimit(usage, isPro = false) {
  return (usage?.chat || 0) >= dailyMessageLimit(isPro)
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
