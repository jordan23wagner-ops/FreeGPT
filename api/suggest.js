// Lightweight follow-up suggestion endpoint. Given the recent conversation, returns a
// short JSON array of 3 natural next questions. Non-streaming and best-effort — any
// failure just returns an empty list so the UI silently shows nothing.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { messages } = req.body || {}
  const OLLAMA_CLOUD_KEY = process.env.OLLAMA_CLOUD_KEY
  const NVIDIA_NIM_KEY = process.env.NVIDIA_NIM_KEY
  if (!OLLAMA_CLOUD_KEY && !NVIDIA_NIM_KEY) return res.status(200).json({ suggestions: [] })

  const convo = (messages || [])
    .map((m) => `${m.role}: ${String(m.content || '').slice(0, 1500)}`)
    .join('\n')
    .slice(-4000)

  const prompt =
    `Based on this conversation, suggest 3 brief follow-up questions the user might ` +
    `naturally ask next. Each must be under 9 words, phrased as the user would ask. ` +
    `Return ONLY a JSON array of 3 strings — no preamble, no code fences.\n\n` +
    `Conversation:\n${convo}`

  try {
    const text = await completeOnce(prompt, OLLAMA_CLOUD_KEY, NVIDIA_NIM_KEY)
    return res.status(200).json({ suggestions: parseSuggestions(text) })
  } catch (err) {
    console.error('suggest failed:', err.message)
    return res.status(200).json({ suggestions: [] })
  }
}

// One-shot (non-streaming) completion: Ollama GPT-OSS first, NIM llama as fallback.
async function completeOnce(prompt, ollamaKey, nimKey) {
  if (ollamaKey) {
    try {
      const r = await fetch('https://ollama.com/api/chat', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ollamaKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-oss:120b', messages: [{ role: 'user', content: prompt }], stream: false }),
      })
      if (r.ok) { const d = await r.json(); const c = d && d.message && d.message.content; if (c) return c }
    } catch { /* fall through to NIM */ }
  }
  if (nimKey) {
    const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${nimKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'meta/llama-3.3-70b-instruct', messages: [{ role: 'user', content: prompt }], max_tokens: 200, stream: false }),
    })
    if (r.ok) { const d = await r.json(); return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '' }
  }
  throw new Error('no provider available')
}

// Pull a string array out of the model's reply, tolerating code fences / stray prose.
function parseSuggestions(text) {
  if (!text) return []
  const match = String(text).match(/\[[\s\S]*\]/)
  if (match) {
    try {
      const arr = JSON.parse(match[0])
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3)
    } catch { /* fall through to line parsing */ }
  }
  // Fallback: one suggestion per line, stripping bullets/numbers/quotes.
  return String(text)
    .split('\n')
    .map((l) => l.replace(/^[-*\d.)\s]+/, '').replace(/^["']|["',]+$/g, '').trim())
    .filter((l) => l.length > 3 && l.length < 80)
    .slice(0, 3)
}
