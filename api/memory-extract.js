// Auto-memory extraction. Given the latest user/assistant exchange, returns durable
// facts worth remembering ABOUT THE USER (preferences, personal details, goals,
// ongoing projects) as a JSON array of short strings — empty if nothing is worth it.
// Non-streaming, best-effort; the client stores whatever comes back (with dedup).

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { messages } = req.body || {}
  const OLLAMA_CLOUD_KEY = process.env.OLLAMA_CLOUD_KEY
  const NVIDIA_NIM_KEY = process.env.NVIDIA_NIM_KEY
  if (!OLLAMA_CLOUD_KEY && !NVIDIA_NIM_KEY) return res.status(200).json({ facts: [] })

  const convo = (messages || [])
    .map((m) => `${m.role}: ${String(m.content || '').slice(0, 1500)}`)
    .join('\n')
    .slice(-4000)

  const prompt =
    `From the exchange below, extract any durable facts about the USER worth remembering ` +
    `long-term: their preferences, personal details, goals, constraints, or ongoing projects. ` +
    `Rules: only facts about the user (not general knowledge or one-off task details), each a ` +
    `concise self-contained sentence in third person ("The user ..."). If nothing is worth ` +
    `remembering, return []. Return ONLY a JSON array of strings, no preamble.\n\n` +
    `Exchange:\n${convo}`

  try {
    const text = await completeOnce(prompt, OLLAMA_CLOUD_KEY, NVIDIA_NIM_KEY)
    return res.status(200).json({ facts: parseFacts(text) })
  } catch (err) {
    console.error('memory-extract failed:', err.message)
    return res.status(200).json({ facts: [] })
  }
}

async function completeOnce(prompt, ollamaKey, nimKey) {
  if (ollamaKey) {
    try {
      const r = await fetch('https://ollama.com/api/chat', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ollamaKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-oss:120b', messages: [{ role: 'user', content: prompt }], stream: false }),
      })
      if (r.ok) { const d = await r.json(); const c = d && d.message && d.message.content; if (c) return c }
    } catch { /* fall through */ }
  }
  if (nimKey) {
    const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${nimKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'meta/llama-3.3-70b-instruct', messages: [{ role: 'user', content: prompt }], max_tokens: 300, stream: false }),
    })
    if (r.ok) { const d = await r.json(); return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '' }
  }
  throw new Error('no provider available')
}

function parseFacts(text) {
  if (!text) return []
  const match = String(text).match(/\[[\s\S]*\]/)
  if (match) {
    try {
      const arr = JSON.parse(match[0])
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string' && x.trim().length > 3).slice(0, 5)
    } catch { /* fall through */ }
  }
  return []
}
