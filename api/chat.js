import { createClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'

// Wagner-GPT chat backend (streaming)
// Strategy: try Ollama Cloud first (free), then Cerebras and Groq (both host the same
// gpt-oss-120b model on separate free-tier quota pools — no quality drop, just different
// infra), falling back to NVIDIA NIM (dev credits, weaker model) last.
// Image generation: NVIDIA NIM FLUX.1-dev primary, Hugging Face FLUX.1-schnell fallback.
// Each provider has a different streaming format; we normalize both into a single
// newline-delimited JSON (NDJSON) stream to the client:
//   {"delta":"token text"}\n   (zero or more)
//   {"image":"<base64 jpeg>","mediaType":"image/jpeg","prompt":"..."}\n   (AI-generated image)
//   {"sources":[{"title":..,"url":..}]}\n   (web search sources, before "done")
//   {"done":true,"provider":"ollama"}\n   (terminal success)
//   {"error":"message"}\n   (terminal failure, only if NOTHING streamed yet)
//
// A request rejected by the shared-quota gate (below) never reaches the NDJSON stream at
// all — it's a plain 429 JSON response, same shape as the "no API keys configured" 500.
//
// Image generation is exposed to the chat model as a `generate_image` tool. When the
// model decides to call it (e.g. "draw a garden"), we run the prompt through NVIDIA
// NIM's FLUX.1-dev endpoint and stream the result as an {"image":...} event.
//
// Web search has three modes (`webSearch` in the request body): 'off' (never), 'on'
// (always search before answering — the old manual toggle), and 'auto' (smart routing:
// the model gets a `web_search` tool and decides for itself whether the question needs
// current/unfamiliar info, same pattern as image generation).
//
// Fallback caveat: once we've flushed the first delta the HTTP response is committed,
// so provider fallback is only possible BEFORE the first token. The wroteAny flag
// reflects this.

// gpt-oss was trained on OpenAI's Harmony format, which has a built-in browser tool that
// cites sources like "【2†L1-L4】" or plain "【1】". Our web_search tool doesn't use that
// schema, but the model sometimes emits the citation habit anyway. Strip it from the
// stream so users see our own "[1]"-style citations instead of a leaked, meaningless
// training-format artifact. Matches only brackets whose *entire* contents are citation-
// shaped (digits/†/L/dashes/commas/whitespace) so real CJK 【】 bracket usage (which
// always contains actual words/characters) is left untouched.
// Chunk-boundary safe: holds back an unresolved "【" until either its "】" arrives (then
// the whole span is checked against the pattern) or the stream ends (then it's flushed
// as-is, since dropping real content is worse than an occasional stray bracket).
const CITATION_ARTIFACT_RE = /【[\dLl†,\-\s]+】/g
function stripCitationArtifacts(rawWrite) {
  let pending = ''
  const write = (text) => {
    if (!text) return
    pending += text
    let emit = pending
    const lastOpen = emit.lastIndexOf('【')
    if (lastOpen !== -1 && !emit.slice(lastOpen).includes('】')) {
      pending = emit.slice(lastOpen)
      emit = emit.slice(0, lastOpen)
    } else {
      pending = ''
    }
    emit = emit.replace(CITATION_ARTIFACT_RE, '')
    if (emit) rawWrite(emit)
  }
  write.flush = () => {
    if (pending) rawWrite(pending)
    pending = ''
  }
  return write
}

// ---- Shared-quota protection ----
// One Ollama Cloud key serves every visitor: GPU-time billed (not token-capped), ~1
// concurrent request on the free tier, and — critically — no API to check remaining
// quota (only the web dashboard and a 90%-usage email). A handful of heavy users can
// exhaust the whole account for everyone, and message-count limits don't actually guard
// against that (a one-word reply and a 3000-word essay cost wildly different GPU-seconds
// but count identically). This tracks OUR OWN estimate of daily generation-time — wall-
// clock seconds spent in the provider call — per identity and for the whole app, and
// blocks new requests before they start once either ceiling is hit.
//
// These numbers are rough starting points, not calibrated to your real Ollama Cloud
// plan (there's no API to calibrate against). Watch the Ollama dashboard / 90%-usage
// email for the first few weeks and tune via these env vars — no redeploy needed.
const ANON_DAILY_SECONDS_CAP = Number(process.env.ANON_DAILY_SECONDS_CAP) || 600      // 10 min/day, no account
const FREE_DAILY_SECONDS_CAP = Number(process.env.FREE_DAILY_SECONDS_CAP) || 1800     // 30 min/day, signed in
const PRO_DAILY_SECONDS_CAP = Number(process.env.PRO_DAILY_SECONDS_CAP) || 7200       // 2 hr/day, Pro
const GLOBAL_DAILY_SECONDS_CAP = Number(process.env.GLOBAL_DAILY_SECONDS_CAP) || 21600 // 6 hr/day, whole app

const SUPABASE_URL = 'https://boleszqdqphfxxwizyoo.supabase.co'
// Not a secret-grade salt — this only keeps raw IPs out of the database at rest, it
// doesn't need to resist a targeted attacker (IPs aren't secret to begin with).
const IP_PEPPER = 'freegpt-usage-v1'

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function hashIp(ip) {
  return 'ip:' + createHash('sha256').update(IP_PEPPER + ip).digest('hex').slice(0, 32)
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (fwd) return String(fwd).split(',')[0].trim()
  return req.socket?.remoteAddress || 'unknown'
}

// Resolves who's calling (for per-identity limits) and which cap applies. Falls back to
// anonymous on any auth/DB hiccup — a quota-tracking outage should never be the reason
// chat goes down entirely.
async function resolveIdentity(req, supabaseAdmin) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (token && supabaseAdmin) {
    try {
      const { data, error } = await supabaseAdmin.auth.getUser(token)
      if (!error && data?.user) {
        let isPro = false
        try {
          const { data: sub } = await supabaseAdmin
            .from('subscriptions')
            .select('plan, status')
            .eq('user_id', data.user.id)
            .maybeSingle()
          isPro = !!sub && sub.plan === 'pro' && (sub.status === 'active' || sub.status === 'trialing')
        } catch { /* treat as free on lookup failure */ }
        return { identity: `user:${data.user.id}`, cap: isPro ? PRO_DAILY_SECONDS_CAP : FREE_DAILY_SECONDS_CAP }
      }
    } catch { /* fall through to anonymous */ }
  }
  return { identity: hashIp(clientIp(req)), cap: ANON_DAILY_SECONDS_CAP }
}

// Reads today's usage for this identity and the whole app. Returns zeros (i.e. never
// blocks) if Supabase isn't configured or the query fails.
async function readUsage(supabaseAdmin, identity) {
  if (!supabaseAdmin) return { identitySeconds: 0, globalSeconds: 0 }
  try {
    const day = todayStr()
    const [{ data: idRow }, { data: globalRow }] = await Promise.all([
      supabaseAdmin.from('usage_ledger').select('seconds').eq('identity', identity).eq('day', day).maybeSingle(),
      supabaseAdmin.from('global_usage').select('seconds').eq('day', day).maybeSingle(),
    ])
    return { identitySeconds: idRow?.seconds || 0, globalSeconds: globalRow?.seconds || 0 }
  } catch {
    return { identitySeconds: 0, globalSeconds: 0 }
  }
}

async function recordUsage(supabaseAdmin, identity, seconds) {
  if (!supabaseAdmin || !(seconds > 0)) return
  try { await supabaseAdmin.rpc('record_usage', { p_identity: identity, p_seconds: seconds }) }
  catch (err) { console.error('record_usage failed:', err.message) }
}

export default async function handler(req, res) {
  // CORS: allow the Job-Assistant browser extension (and any client) to call this free
  // chat backend cross-origin. The endpoint is already unauthenticated and public to the
  // PWA, so reflecting the origin doesn't widen exposure — it just lets a
  // chrome-extension:// origin through the preflight. No credentials are used.
  const origin = req.headers.origin
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(204).end()

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { messages, newMessage, image, images, model, webSearch, document, style, memory, customInstructions, aboutYou } = req.body

  // Normalize uploads to a list: prefer the new `images` array, fall back to the legacy
  // single `image`. Each entry is { data: base64, mediaType }.
  const imageList = Array.isArray(images) && images.length ? images : (image ? [image] : [])

  const OLLAMA_CLOUD_KEY = process.env.OLLAMA_CLOUD_KEY
  const NVIDIA_NIM_KEY = process.env.NVIDIA_NIM_KEY
  const HUGGINGFACE_KEY = process.env.HUGGINGFACE_KEY
  const TAVILY_KEY = process.env.TAVILY_KEY || process.env.TAVILY_API_KEY || process.env.TAVILY
  // Both optional — absent means those fallback tiers are just skipped, same as NIM
  // already behaves when NVIDIA_NIM_KEY isn't set.
  const CEREBRAS_KEY = process.env.CEREBRAS_KEY
  const GROQ_KEY = process.env.GROQ_KEY

  if (!OLLAMA_CLOUD_KEY && !NVIDIA_NIM_KEY) {
    return res.status(500).json({ error: 'No API keys configured (need OLLAMA_CLOUD_KEY and/or NVIDIA_NIM_KEY).' })
  }

  // Shared-quota gate — runs before any provider call, so a request that's going to be
  // rejected never spends any of the shared Ollama/NIM budget. Inert (never blocks) until
  // SUPABASE_SERVICE_ROLE_KEY is set and the usage_ledger/global_usage tables exist.
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null
  const { identity, cap: identityCap } = await resolveIdentity(req, supabaseAdmin)
  const { identitySeconds, globalSeconds } = await readUsage(supabaseAdmin, identity)

  if (globalSeconds >= GLOBAL_DAILY_SECONDS_CAP) {
    return res.status(429).json({
      error: "Vessa is at capacity for today — this runs on one shared free AI account. It resets in a few hours, or upgrade to Pro for priority access.",
    })
  }
  if (identitySeconds >= identityCap) {
    return res.status(429).json({
      error: identity.startsWith('user:')
        ? "You've used your daily allowance on the free plan. It resets at midnight, or upgrade to Pro in Settings for more headroom."
        : "You've used your daily allowance for chats without an account. Sign in for a higher daily limit, or try again after it resets.",
    })
  }
  const genStart = Date.now()

  // Provider-specific model IDs for each dropdown choice.
  // Ollama Cloud tags must match exactly what `GET https://ollama.com/api/tags`
  // returns for this account (no `:cloud` suffix). NIM IDs must be live in the
  // catalog at https://integrate.api.nvidia.com/v1/models (EOL models 410/Gone).
  const MODEL_MAP = {
    m3:       { ollama: 'minimax-m3',              nim: 'minimaxai/minimax-m3',          order: ['ollama', 'nim'] },
    // NIM fallback is text-only (images are stripped), so gemma's backstop is just a
    // reliable text model. The NIM gemma deployments 404/time-out; llama-3.3 is steady.
    gemma:    { ollama: 'gemma4:31b',              nim: 'meta/llama-3.3-70b-instruct',   order: ['ollama', 'nim'] },
    // Smarter free Ollama Cloud model (no vision). gpt-oss is a fast MoE with strong
    // reasoning + reliable tool-calling. llama-3.3 is the text-only NIM backstop.
    // Cerebras and Groq both host this SAME model for free (different accounts, GPU-time
    // billed vs request/token-rate billed — a genuinely separate quota pool from Ollama's),
    // so they slot in ahead of NIM: same answer quality, just from different infra, before
    // dropping to NIM's weaker llama-3.3-70b as the last resort. m3/gemma have no Cerebras/
    // Groq equivalent on the free tier, so those two model routes stay Ollama->NIM only.
    gptoss:   { ollama: 'gpt-oss:120b', cerebras: 'gpt-oss-120b', groq: 'openai/gpt-oss-120b', nim: 'meta/llama-3.3-70b-instruct', order: ['ollama', 'cerebras', 'groq', 'nim'] }
    // Evaluated glm-5 and deepseek-v3.1:671b — neither tag resolves on the free tier
    // (both fall back to NIM) and DeepSeek is slow. gpt-oss:120b stays the smart pick.
  }

  // Resolve the effective model.
  //  - 'auto' routes to GPT-OSS for text, and Gemma whenever vision or image generation
  //    is involved (GPT-OSS is text-only and can't see uploads or drive the generate_image
  //    tool).
  //  - Image requests / photo uploads ALWAYS route to Gemma, even under a manual
  //    non-Gemma selection, so "draw me X" and "what's in this photo?" just work.
  const wantsImage = isImageRequest(newMessage)
  const hasVisionInput = imageList.length > 0
  let effectiveModel = model
  if (model === 'auto') {
    effectiveModel = (wantsImage || hasVisionInput) ? 'gemma' : 'gptoss'
  } else if ((wantsImage || hasVisionInput) && model !== 'gemma' && model !== 'm3') {
    // Manual GPT-OSS can't see images or generate them — fall to Gemma.
    effectiveModel = 'gemma'
  } else if (wantsImage && model === 'm3') {
    effectiveModel = 'gemma'
  }

  const ids = MODEL_MAP[effectiveModel]
  if (!ids) {
    return res.status(400).json({ error: `Unknown model: ${model}` })
  }

  // Photo-informed generation: when a photo is attached AND the user asks to change/show
  // it ("show this garden in full summer bloom"), read the photo with the vision model to
  // build a prompt, then generate a fresh image of that requested future state.
  // NOTE: true pixel-level editing of the exact photo isn't available on the free hosted
  // tier — NVIDIA's hosted FLUX.1 Kontext only accepts its own demo images — so this is an
  // AI re-imagining based on the photo, and we label it as such in the reply.
  const hasGen = NVIDIA_NIM_KEY || HUGGINGFACE_KEY
  if (hasVisionInput && hasGen && (wantsImage || isEditRequest(newMessage))) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    try {
      // Turn the photo + request into a vivid generation prompt (best-effort; on failure
      // we just generate from the user's raw words).
      let genPrompt = newMessage
      if (OLLAMA_CLOUD_KEY) {
        try { genPrompt = await describeForEdit(imageList.map((i) => i.data), newMessage, OLLAMA_CLOUD_KEY) }
        catch (e) { console.error('vision prompt failed:', e.message) }
      }
      let b64 = null
      const errs = []
      if (NVIDIA_NIM_KEY) {
        try { b64 = await generateImage(genPrompt, NVIDIA_NIM_KEY) }
        catch (e) { errs.push(`NIM: ${e.message}`); console.error('NIM gen failed:', e.message) }
      }
      // HF's free endpoint frequently network-fails; wrap so it can't mask other errors.
      if (!b64 && HUGGINGFACE_KEY) {
        try { b64 = await generateImageHF(genPrompt, HUGGINGFACE_KEY) }
        catch (e) { errs.push(`HF: ${e.message}`); console.error('HF gen failed:', e.message) }
      }
      // Pollinations: free, no key, no aggressive filter — the reliable last resort.
      if (!b64) {
        try { b64 = await generateImagePollinations(genPrompt) }
        catch (e) { errs.push(`Pollinations: ${e.message}`); console.error('Pollinations gen failed:', e.message) }
      }
      if (!b64) throw new Error(errs.join(' · ') || 'image generation failed')
      res.write(JSON.stringify({ image: b64, mediaType: 'image/jpeg', prompt: genPrompt }) + '\n')
      res.write(JSON.stringify({ delta: '\n\n_An AI re-imagining based on your photo — not a pixel-edit of the original._' }) + '\n')
      res.write(JSON.stringify({ done: true, provider: 'nim', model: 'vision-gen' }) + '\n')
    } catch (err) {
      console.error('photo-informed gen failed:', err.message)
      res.write(JSON.stringify({ error: `Couldn't create the image: ${err.message}` }) + '\n')
    }
    return res.end()
  }

  // Normalize the three search modes. Booleans are accepted for backward-compat with
  // older clients that only knew on/off.
  const searchMode = webSearch === true ? 'on' : (webSearch === false || webSearch == null ? 'off' : webSearch)

  // 'on': always search BEFORE the model so we can inject current results as context.
  // Skipped for image requests (no point searching "draw a cat").
  let searchData = null
  if (searchMode === 'on' && TAVILY_KEY && newMessage && !wantsImage) {
    try {
      searchData = await runWebSearch(newMessage, TAVILY_KEY)
    } catch (err) {
      console.error('Web search failed:', err.message)
    }
  }

  // 'auto': offer the model a web_search tool instead, so it decides for itself.
  const offerSearchTool = searchMode === 'auto' && !!TAVILY_KEY && !!newMessage && !wantsImage

  // Build a normalized message list (text + optional image part).
  const history = (messages || []).map(m => ({ role: m.role, content: m.content }))
  const userTurn = {
    role: 'user',
    content: imageList.length
      ? [
          { type: 'text', text: newMessage },
          ...imageList.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType || 'image/jpeg'};base64,${img.data}` },
          })),
        ]
      : newMessage
  }
  // Prepend any context system messages: a baseline honesty/grounding rule first (applies
  // regardless of persona), then persona + memory, then style guidance, attached document,
  // and web search.
  const systemMsgs = []

  // Baseline anti-hallucination instruction, always on. Cheap (no extra request) compared
  // to a verification pass, and this is where most hallucination-reduction guides say to
  // start: abstention beats a wrong-but-confident answer. Also seeds today's date so the
  // model isn't reasoning from a stale "as of my training cutoff" assumption even outside
  // web search.
  const today = new Date().toISOString().slice(0, 10)
  systemMsgs.push({
    role: 'system',
    content:
      `Today's date is ${today}. Be direct and helpful, but don't fabricate: if you're not ` +
      `confident about a specific fact (a date, statistic, name, quote, or citation), say so ` +
      `plainly instead of guessing, and prefer admitting uncertainty over a made-up-sounding ` +
      `answer. Never invent citations, links, or sources.`,
  })

  // Custom instructions / "about you" — always applied when set.
  const personaBits = []
  if (aboutYou && String(aboutYou).trim()) personaBits.push(`About the user: ${String(aboutYou).trim()}`)
  if (customInstructions && String(customInstructions).trim()) personaBits.push(`How the user wants you to respond: ${String(customInstructions).trim()}`)
  if (personaBits.length) systemMsgs.push({ role: 'system', content: personaBits.join('\n\n') })

  // Relevant long-term memories retrieved client-side for this query.
  if (Array.isArray(memory) && memory.length) {
    const lines = memory.map((m) => `- ${m}`).join('\n')
    systemMsgs.push({ role: 'system', content: `Relevant things you remember about the user:\n${lines}` })
  }

  const styleMsg = STYLE_PROMPTS[style]
  if (styleMsg) systemMsgs.push({ role: 'system', content: styleMsg })
  if (document && document.text) {
    systemMsgs.push({
      role: 'system',
      content:
        `The user attached a document named "${document.name}". The text below may be the ` +
        `full document or the excerpts most relevant to the question. Use it to answer, ` +
        `summarize, or rewrite as asked, and say so if it looks incomplete for the ask. ` +
        `Document contents:\n\n${document.text}`,
    })
  }
  if (searchData) systemMsgs.push(buildSearchSystem(newMessage, searchData))
  const fullMessages = [...systemMsgs, ...history, userTurn]

  // Stream headers. We commit these immediately; everything after is NDJSON chunks.
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')

  // Shared writer + a flag tracking whether any token has been flushed.
  const state = { wroteAny: false }
  const writeDelta = stripCitationArtifacts((text) => {
    if (!text) return
    state.wroteAny = true
    res.write(JSON.stringify({ delta: text }) + '\n')
  })

  const errors = []

  // Offer the image tool when any image provider is available, and the search tool
  // when in 'auto' mode. Both are Ollama-only (NIM never receives a tools list).
  const hasImageProvider = NVIDIA_NIM_KEY || HUGGINGFACE_KEY
  const toolList = []
  if (hasImageProvider) toolList.push(IMAGE_TOOL)
  if (offerSearchTool) toolList.push(WEB_SEARCH_TOOL)
  const tools = toolList.length ? toolList : undefined

  // 1) Try Ollama Cloud first (free path).
  if (OLLAMA_CLOUD_KEY) {
    try {
      const { toolCall } = await streamOllama(fullMessages, ids.ollama, OLLAMA_CLOUD_KEY, writeDelta, tools)
      if (toolCall && toolCall.function.name === 'generate_image') {
        await runImageTool(toolCall, newMessage, NVIDIA_NIM_KEY, HUGGINGFACE_KEY, res, writeDelta)
      } else if (toolCall && toolCall.function.name === 'web_search') {
        await runWebSearchTool(toolCall, newMessage, fullMessages, ids, OLLAMA_CLOUD_KEY, CEREBRAS_KEY, GROQ_KEY, NVIDIA_NIM_KEY, TAVILY_KEY, res, writeDelta)
      }
      if (searchData) emitSources(res, searchData)
      writeDelta.flush()
      await recordUsage(supabaseAdmin, identity, (Date.now() - genStart) / 1000)
      res.write(JSON.stringify({ done: true, provider: 'ollama', model: effectiveModel }) + '\n')
      return res.end()
    } catch (err) {
      console.error('Ollama failed:', err.message)
      errors.push(`Ollama: ${err.message}`)
      // Only safe to fall through if we haven't sent any tokens yet.
      if (state.wroteAny) {
        writeDelta.flush()
        await recordUsage(supabaseAdmin, identity, (Date.now() - genStart) / 1000)
        res.write(JSON.stringify({ error: `Stream interrupted (Ollama): ${err.message}` }) + '\n')
        return res.end()
      }
      // else: fall through to the text-only fallbacks below
    }
  }

  // 2) Plain-text fallbacks, in priority order: Cerebras and Groq both host the SAME
  // gpt-oss-120b model Ollama serves (no quality drop), on completely separate quota
  // pools — only NIM (weaker model, "evaluation only" ToS caution) is the last resort.
  // None of these support tools (image-gen/web-search), same as NIM's existing behavior —
  // a degraded-but-working answer beats none once the primary/faster options are out.
  // `model` is undefined on the entry for a route that has no equivalent on that provider
  // (e.g. m3/gemma have no Cerebras/Groq match), so those are skipped automatically.
  const textFallbacks = [
    { name: 'cerebras', key: CEREBRAS_KEY, model: ids.cerebras, url: 'https://api.cerebras.ai/v1/chat/completions' },
    { name: 'groq', key: GROQ_KEY, model: ids.groq, url: 'https://api.groq.com/openai/v1/chat/completions' },
    { name: 'nim', key: NVIDIA_NIM_KEY, model: ids.nim, url: 'https://integrate.api.nvidia.com/v1/chat/completions' },
  ]

  for (const fb of textFallbacks) {
    if (!fb.key || !fb.model || state.wroteAny) continue
    try {
      await streamOpenAICompatible(fb.url, fullMessages, fb.model, fb.key, writeDelta, fb.name)
      if (searchData) emitSources(res, searchData)
      writeDelta.flush()
      await recordUsage(supabaseAdmin, identity, (Date.now() - genStart) / 1000)
      res.write(JSON.stringify({ done: true, provider: fb.name, model: effectiveModel }) + '\n')
      return res.end()
    } catch (err) {
      console.error(`${fb.name} failed:`, err.message)
      errors.push(`${fb.name}: ${err.message}`)
      if (state.wroteAny) {
        writeDelta.flush()
        await recordUsage(supabaseAdmin, identity, (Date.now() - genStart) / 1000)
        res.write(JSON.stringify({ error: `Stream interrupted (${fb.name}): ${err.message}` }) + '\n')
        return res.end()
      }
      // else: fall through to the next provider in the list
    }
  }

  // Every available provider failed before emitting anything.
  const msg = 'All available models failed. ' + (errors[errors.length - 1] || 'Please try again shortly.')
  res.write(JSON.stringify({ error: msg }) + '\n')
  return res.end()
}


// ---- Auto-routing heuristics ----
//
// Cheap, deterministic intent detection so 'auto' mode and image-request switching
// cost zero extra API calls. Tuned to be permissive on image intent (cheap to be
// wrong — Gemma just answers normally) and conservative on the M3 reasoning route.

// Does this read like an image-generation request?
const IMAGE_INTENT_RE =
  /\b(draw|paint|sketch|render|generate|create|make|design|show me)\b[^.?!]*\b(image|picture|photo|pic|art|drawing|painting|illustration|logo|wallpaper|portrait|scene|landscape|icon|avatar)\b|\b(draw|paint|sketch)\s+(me\s+)?(a|an|the|some)\b/i

function isImageRequest(text) {
  return typeof text === 'string' && IMAGE_INTENT_RE.test(text)
}

// Does this read like a request to TRANSFORM an uploaded photo (image-to-image)? Only
// consulted when an image is actually attached, so it can be fairly liberal — the cost of
// a false positive is editing instead of describing. Intentionally excludes pure
// questions ("what's in this?", "describe this") which should stay as vision Q&A.
const EDIT_INTENT_RE =
  /\b(edit|change|turn|transform|convert|add|remove|replace|repaint|restyle|redesign|recolou?r|enhance|improve|make (it|this|the|them)|show (it|this|the|me)|what (would|will) (it|this|the)|in (summer|winter|spring|autumn|fall)|fully grown|matured?|next (year|season|month)|years? (from now|later)|in (full )?bloom|blooming|grown( up)?|future)\b/i

function isEditRequest(text) {
  return typeof text === 'string' && EDIT_INTENT_RE.test(text)
}

// Response-style guidance, injected as a system message so the user controls verbosity
// and whether code is included. 'default' adds nothing.
const STYLE_PROMPTS = {
  quick: 'Answer as briefly as possible — at most 2-3 sentences. Skip preamble and do not include code unless the user explicitly asks for it.',
}

// ---- Web search (Tavily) ----
//
// Tavily is LLM-optimized: one call returns a synthesized answer plus ranked source
// snippets. We inject those as a system message so the model answers from current
// info, then append a clickable Sources list to the reply.

async function runWebSearch(query, key) {
  // Bias toward the current year so "most recent X" questions surface this year's
  // pages instead of an older page that just happens to rank well (the failure mode
  // we saw live: the model picked a 2024 Super Bowl page over a newer 2025 result
  // already sitting in its own result set). Skipped if the query already names a year.
  const year = new Date().getFullYear()
  const searchQuery = /\b(19|20)\d{2}\b/.test(query) ? query : `${query} ${year}`
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: String(searchQuery).slice(0, 400),
      max_results: 5,
      include_answer: true,
      // 'advanced' does deeper content extraction than 'basic' — costs more Tavily
      // credits per call, but richer/more accurate snippets are worth it now that
      // search is the main lever we have against stale/wrong time-sensitive answers.
      search_depth: 'advanced',
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Tavily ${response.status} ${body.slice(0, 120)}`)
  }
  const data = await response.json()
  const results = Array.isArray(data.results) ? data.results.slice(0, 5) : []
  if (!results.length && !data.answer) throw new Error('no results')
  return { answer: data.answer || '', results }
}

function buildSearchSystem(query, search) {
  const today = new Date().toISOString().slice(0, 10)
  const lines = search.results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${String(r.content || '').slice(0, 800)}`)
    .join('\n\n')
  return {
    role: 'system',
    content:
      `Today's date is ${today}. The web search results below are more current than your ` +
      `training data — for anything time-sensitive (scores, prices, releases, schedules, ` +
      `"latest"/"current"/"most recent" anything), trust these results over what you already ` +
      `"know", even if it contradicts your training. Some results may be older than others — ` +
      `check each one for its own date/event and, for "most recent" style questions, go with ` +
      `whichever result describes the most recent actual event, not just the first or most ` +
      `confident-sounding one. Cite inline using ONLY ASCII square brackets like [1], [2] — ` +
      `do not use fullwidth brackets (【1】) or any dagger/line-range reference (†, L1-L4); ` +
      `that citation style is not supported here and will look broken to the user. Be ` +
      `concise. If the results don't cover the question, or genuinely conflict on which is ` +
      `more recent, say so plainly instead of guessing.\n\nQuery: ${query}\n\n` +
      (search.answer ? `Quick summary: ${search.answer}\n\n` : '') +
      `Results:\n${lines}`,
  }
}

// Emits sources as a structured NDJSON event (title+url only) instead of appending a
// markdown list to the reply text. The frontend renders these as clickable inline
// citation badges ([1], [2]...) plus a source-card row, Perplexity-style, rather than a
// plain link list. Filtered to http(s) only — defense in depth even though Tavily should
// only ever return those.
function emitSources(res, search) {
  const items = (search.results || [])
    .filter((r) => r && r.url && /^https?:\/\//i.test(r.url))
    .slice(0, 5)
    .map((r) => ({ title: String(r.title || '').slice(0, 200), url: r.url }))
  if (items.length) res.write(JSON.stringify({ sources: items }) + '\n')
}

// ---- Provider streamers ----
//
// Each streamer connects with stream:true, reads the body, parses provider-specific
// chunks, and calls onDelta(text) for each token. Connect-time failures (network /
// non-OK status) are retried with backoff BEFORE the first byte is read. Once the
// body is streaming we no longer retry.

const MAX_RETRIES = 2
const BASE_DELAY_MS = 600
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const backoff = (attempt) => BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250)

// Open a streaming POST with connect retry on 429/5xx/network. Returns the Response
// once status is OK; throws on exhausted retries.
async function openWithRetry(url, options) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response
    try {
      response = await fetch(url, options)
    } catch (netErr) {
      if (attempt < MAX_RETRIES) { await sleep(backoff(attempt)); continue }
      throw new Error('network error')
    }

    if (response.ok) return response

    const retryable = response.status === 429 || response.status >= 500
    if (retryable && attempt < MAX_RETRIES) { await sleep(backoff(attempt)); continue }

    const body = await response.text().catch(() => '')
    throw new Error(`${response.status} ${body.slice(0, 200)}`)
  }
  throw new Error('exhausted retries')
}

// Iterate decoded text chunks from a fetch Response body, yielding complete lines.
// Buffers partial lines across chunks. Works with both Web ReadableStream (reader)
// and Node Readable (async iterator) bodies.
async function* iterLines(response) {
  const decoder = new TextDecoder()
  let buffer = ''

  function* drain() {
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      yield line
    }
  }

  const body = response.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      yield* drain()
    }
  } else {
    // Node stream fallback
    for await (const chunk of body) {
      buffer += (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))
      yield* drain()
    }
  }

  if (buffer.length) yield buffer
}

// Ollama Cloud: native /api/chat, stream:true -> NDJSON, one JSON object per line:
//   { "message": { "content": "..." }, "done": false }
// M3 supports vision; images go as a separate images:[base64] array on the message.
async function streamOllama(messages, model, apiKey, onDelta, tools) {
  const ollamaMessages = messages.map(m => {
    if (Array.isArray(m.content)) {
      const text = m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      const imgs = m.content
        .filter(c => c.type === 'image_url')
        .map(c => (c.image_url.url.split(',')[1]))
      return imgs.length ? { role: m.role, content: text, images: imgs } : { role: m.role, content: text }
    }
    return { role: m.role, content: m.content }
  })

  const payload = { model, messages: ollamaMessages, stream: true }
  if (tools && tools.length) payload.tools = tools

  const response = await openWithRetry('https://ollama.com/api/chat', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  let got = false
  let toolCall = null
  for await (const line of iterLines(response)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj
    try { obj = JSON.parse(trimmed) } catch { continue }
    if (obj.error) throw new Error(String(obj.error).slice(0, 200))
    const m = obj && obj.message
    if (m) {
      if (!toolCall && Array.isArray(m.tool_calls)) {
        const tc = m.tool_calls.find(t => t.function && (t.function.name === 'generate_image' || t.function.name === 'web_search'))
        if (tc) toolCall = tc
      }
      if (m.content) { got = true; onDelta(m.content) }
    }
    if (obj.done) break
  }
  // A tool call is a valid outcome even when the model emits no text.
  if (!got && !toolCall) throw new Error('empty response')
  return { toolCall }
}

// ---- Image generation (generate_image tool -> NVIDIA NIM FLUX.1-dev) ----

// Tool schema advertised to the chat model. Description is deliberately explicit so
// the model reliably routes "draw / paint / create / show a picture" requests here.
const IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: 'Generate an image from a text description. Call this whenever the user asks you to draw, paint, create, generate, render, or show a picture/image/photo of something.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'A detailed, vivid description of the image to generate.' }
      },
      required: ['prompt']
    }
  }
}

// Tool schema advertised to the chat model in 'auto' search mode. Description leans on
// the model's own judgment of its knowledge confidence, not keyword-matching.
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the live web. Call this when the question needs current or recent information ' +
      '(news, prices, scores, releases, schedules, "latest"/"today"/"this year"), or when you ' +
      "are not confident you know the answer accurately from training. Don't call it for " +
      'things you already know well, general knowledge, or math/reasoning/writing tasks.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A focused search query capturing exactly what needs to be looked up.' }
      },
      required: ['query']
    }
  }
}

// Runs when the model calls web_search in 'auto' mode. Announces the search (so the
// user sees why there's a pause), fetches results, then re-asks the SAME model without
// tools so it commits to a text answer grounded in them.
async function runWebSearchTool(toolCall, fallbackPrompt, baseMessages, ids, ollamaKey, cerebrasKey, groqKey, nimKey, tavilyKey, res, onDelta) {
  let args = {}
  try { args = JSON.parse(toolCall.function.arguments || '{}') } catch { /* use fallback */ }
  const query = (args.query && String(args.query).trim()) || fallbackPrompt

  onDelta(`🔎 Searching the web for "${query}"…\n\n`)
  const search = await runWebSearch(query, tavilyKey)
  const messages = [...baseMessages, buildSearchSystem(query, search)]

  // Same priority order as the main fallback chain: same-model-quality-first (Cerebras/
  // Groq), NIM last.
  if (ollamaKey) await streamOllama(messages, ids.ollama, ollamaKey, onDelta, undefined)
  else if (cerebrasKey && ids.cerebras) await streamOpenAICompatible('https://api.cerebras.ai/v1/chat/completions', messages, ids.cerebras, cerebrasKey, onDelta, 'cerebras')
  else if (groqKey && ids.groq) await streamOpenAICompatible('https://api.groq.com/openai/v1/chat/completions', messages, ids.groq, groqKey, onDelta, 'groq')
  else if (nimKey) await streamOpenAICompatible('https://integrate.api.nvidia.com/v1/chat/completions', messages, ids.nim, nimKey, onDelta, 'nim')
  else throw new Error('no provider available for follow-up answer')

  emitSources(res, search)
}

// Run a fetch with a hard deadline so a slow/hanging provider can't consume the whole
// 60s function budget (which manifested as "times out" / truncated black images). On
// timeout we abort and throw so the caller falls back to the next provider.
async function fetchWithTimeout(url, options, ms, label) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${label} timed out after ${ms / 1000}s`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// A real 1024² JPEG is well over this; anything smaller is an empty/black/truncated
// result, which we reject so the caller can fall back instead of showing a black box.
const MIN_IMAGE_B64 = 6000

// FLUX.1-dev accepts width/height only from a fixed set; 1024 square is the safe default.
// 20 steps keeps quality high while shaving latency to stay well inside the function cap.
async function generateImage(prompt, nimKey) {
  const response = await fetchWithTimeout('https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${nimKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      prompt: String(prompt).slice(0, 1500),
      width: 1024,
      height: 1024,
      steps: 20,
      cfg_scale: 3.5,
      seed: Math.floor(Math.random() * 1e9)
    })
  }, 35000, 'NIM image')
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${response.status} ${body.slice(0, 150)}`)
  }
  const data = await response.json()
  const art = (data && data.artifacts && data.artifacts[0]) || {}
  const b64 = art.base64
  if (!b64) throw new Error('no image returned')
  // Only reject on an EXPLICIT content-filter result (NVIDIA returns a black image with a
  // CONTENT_FILTERED reason when its safety filter trips, and it false-positives). Other
  // non-success reason values vary by deployment and may still carry a valid image, so we
  // do NOT reject them — the size guard below still catches truly-empty results. We carry
  // the raw reason in the error so it's visible if it really is a filter.
  const reason = String(art.finishReason || art.finish_reason || '').toUpperCase()
  if (reason.includes('FILTER')) {
    throw new Error(`content-filtered (${reason || 'unknown'})`)
  }
  if (b64.length < MIN_IMAGE_B64) throw new Error('image came back empty')
  return b64
}

// Vision-guided prompt builder: show the uploaded photo to Gemma (Ollama, non-streaming)
// and have it write a single vivid text-to-image prompt describing the SAME scene with
// the user's requested change, keeping the layout and subjects recognizable. The result
// feeds generateImage()/generateImageHF(). Best-effort — caller falls back to raw text.
async function describeForEdit(imageBase64List, instruction, ollamaKey) {
  const imgs = Array.isArray(imageBase64List) ? imageBase64List : [imageBase64List]
  const messages = [
    {
      role: 'system',
      content:
        'You write prompts for a text-to-image model. Look at the attached image(s) and the ' +
        'user request, then output ONE vivid prompt (max 80 words) describing the SAME ' +
        'scene transformed as requested — keep the layout, plants, structures, and setting ' +
        'recognizable. If several images are given, combine them into one coherent scene. ' +
        'Describe only the garden, plants, and landscape — do NOT mention people, faces, ' +
        'children, or bodies (that can trip content filters). ' +
        'Output only the prompt text, no preamble or quotes.',
    },
    { role: 'user', content: instruction || 'Show this scene in a future state.', images: imgs },
  ]
  const response = await fetchWithTimeout('https://ollama.com/api/chat', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ollamaKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemma4:31b', messages, stream: false }),
  }, 30000, 'vision prompt')
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${response.status} ${body.slice(0, 120)}`)
  }
  const data = await response.json()
  const out = data && data.message && data.message.content
  if (!out || !out.trim()) throw new Error('empty vision prompt')
  return out.trim().slice(0, 1500)
}

// Hugging Face Inference API: FLUX.1-schnell (free, rate-limited, no credit pool).
// Returns raw image bytes; we base64-encode them for the NDJSON stream.
async function generateImageHF(prompt, hfKey) {
  const response = await fetchWithTimeout(
    'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hfKey}`,
        'Content-Type': 'application/json',
        'Accept': 'image/jpeg',
      },
      body: JSON.stringify({ inputs: String(prompt).slice(0, 1500) }),
    },
    30000, 'HuggingFace image'
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`HF ${response.status} ${body.slice(0, 150)}`)
  }
  const buf = await response.arrayBuffer()
  // Buffer is faster and safer than a per-byte String.fromCharCode loop (which can choke
  // on a megabyte-sized image).
  const b64 = Buffer.from(buf).toString('base64')
  if (b64.length < MIN_IMAGE_B64) throw new Error('HF returned empty image')
  return b64
}

// Pollinations.ai: free, no API key, and NOT behind NVIDIA's aggressive CONTENT_FILTERED
// gate — our reliable fallback when NIM filters a benign prompt or HF is down. Simple GET
// returns the image bytes directly.
async function generateImagePollinations(prompt) {
  const p = encodeURIComponent(String(prompt).slice(0, 1500))
  const seed = Math.floor(Math.random() * 1e9)
  const url = `https://image.pollinations.ai/prompt/${p}?width=1024&height=1024&nologo=true&seed=${seed}`
  const response = await fetchWithTimeout(url, { method: 'GET', headers: { 'Accept': 'image/jpeg' } }, 45000, 'Pollinations image')
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Pollinations ${response.status} ${body.slice(0, 120)}`)
  }
  const buf = await response.arrayBuffer()
  const b64 = Buffer.from(buf).toString('base64')
  if (b64.length < MIN_IMAGE_B64) throw new Error('Pollinations returned empty image')
  return b64
}

// Execute a generate_image tool call: pull the prompt, try NIM then HF, stream the image.
// Never throws — on failure it streams a short note so the request still completes.
async function runImageTool(toolCall, fallbackPrompt, nimKey, hfKey, res, onDelta) {
  let prompt = fallbackPrompt
  try {
    const args = toolCall.function.arguments
    const parsed = typeof args === 'string' ? JSON.parse(args) : args
    if (parsed && parsed.prompt) prompt = parsed.prompt
  } catch { /* fall back to the user's raw message */ }

  // Try NVIDIA NIM first (higher quality), then HuggingFace, then Pollinations (free,
  // no key, no aggressive filter — always available as a last resort).
  if (nimKey) {
    try {
      const b64 = await generateImage(prompt, nimKey)
      res.write(JSON.stringify({ image: b64, mediaType: 'image/jpeg', prompt }) + '\n')
      return
    } catch (err) {
      console.error('NIM FLUX failed, trying HuggingFace:', err.message)
    }
  }

  if (hfKey) {
    try {
      const b64 = await generateImageHF(prompt, hfKey)
      res.write(JSON.stringify({ image: b64, mediaType: 'image/jpeg', prompt }) + '\n')
      return
    } catch (err) {
      console.error('HuggingFace FLUX failed, trying Pollinations:', err.message)
    }
  }

  try {
    const b64 = await generateImagePollinations(prompt)
    res.write(JSON.stringify({ image: b64, mediaType: 'image/jpeg', prompt }) + '\n')
    return
  } catch (err) {
    console.error('Pollinations failed:', err.message)
    onDelta(`\n\n⚠️ Couldn't generate the image: ${err.message}`)
  }
}

// Groq and Cerebras both return real-time remaining-quota headers on every response
// (different header names each) — unlike Ollama, which exposes no quota API at all.
// Logging them gives ground-truth headroom visibility in Vercel's function logs, cheaper
// than building a persisted tracking table for two providers whose limits already
// self-enforce via the normal 429-and-fall-through path anyway.
function logRateLimitHeaders(label, response) {
  const h = response.headers
  const reqRemaining = h.get('x-ratelimit-remaining-requests') || h.get('x-ratelimit-remaining-requests-day')
  const tokRemaining = h.get('x-ratelimit-remaining-tokens') || h.get('x-ratelimit-remaining-tokens-minute')
  if (reqRemaining != null || tokRemaining != null) {
    console.log(`[quota] ${label}: requests remaining=${reqRemaining ?? '?'} tokens remaining=${tokRemaining ?? '?'}`)
  }
}

// Generic OpenAI-compatible chat-completions streamer (SSE `data: {...}` lines). NIM,
// Cerebras, and Groq all speak this exact wire format — only the base URL, model catalog,
// and key differ — so one function serves all three text-only fallback tiers.
//   data: { "choices": [{ "delta": { "content": "..." } }] }
//   data: [DONE]
// Text-only -- strip images.
async function streamOpenAICompatible(baseUrl, messages, model, apiKey, onDelta, label) {
  const textMessages = messages.map(m => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      : m.content
  }))

  const response = await openWithRetry(baseUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, messages: textMessages, temperature: 0.7, max_tokens: 2048, stream: true })
  })
  logRateLimitHeaders(label, response)

  let got = false
  for await (const line of iterLines(response)) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') break
    let obj
    try { obj = JSON.parse(payload) } catch { continue }
    const piece = obj && obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content
    if (piece) { got = true; onDelta(piece) }
  }
  if (!got) throw new Error('empty response')
}
