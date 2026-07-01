import React, { useState, useRef, useEffect } from 'react'
import {
  Send, Paperclip, Sun, Moon, Trash2, MessageSquare,
  Menu, Plus, X, FileText, Printer,
} from 'lucide-react'
import {
  loadConversations, saveConversations, loadActiveId, saveActiveId,
  newConversation, titleFromMessages,
} from './lib/conversations'
import { cacheKey, getCached, setCached, looksLikeImageRequest } from './lib/cache'
import { loadUsage, bumpUsage, IMAGE_DAILY_SOFT_LIMIT, overMessageLimit, dailyMessageLimit } from './lib/usage'
import { exportWord, exportPdf, exportReplyWord, exportReplyPdf } from './lib/exportChat'
import { Download, Globe, Mic, FileUp, Volume2, Square, Loader2, Copy, Check, RefreshCw, Pencil, Search } from 'lucide-react'
import renderMarkdown from './lib/renderMarkdown'
import { parseDocument, isSupportedDocument } from './lib/parseDocument'
import { THEMES, isDarkTheme } from './lib/themes'
import { Palette } from 'lucide-react'
import { enhanceMessages } from './lib/enhanceMessages'
import { attachRunButtons } from './lib/codeRunner'
import { attachArtifacts } from './lib/artifacts'
import {
  storeMemory, retrieveMemories, listMemories, deleteMemory,
  loadSettings, saveSettings, memoryAvailable,
} from './lib/memory'
import { warmEmbedder } from './lib/embed'
import { RAG_THRESHOLD, docId, buildIndex, retrieveChunks } from './lib/rag'
import { Share2 } from 'lucide-react'
import SharedChat from './SharedChat'
import { createShare, loadShare, shareUrl, shareIdFromUrl, listShares, deleteShare } from './lib/share'
import { Settings, Brain, Trash, LogIn, LogOut, Mail } from 'lucide-react'
import { hasSupabase } from './lib/supabase'
import { initAuth, onAuthChange, signInWithEmail, signInWithGoogle, signOut } from './lib/auth'
import { syncConversationsDown, syncConversationUp, syncDeleteConversation } from './lib/sync'

// Inset so the header/input clear the phone's status bar (time/battery) and home
// indicator. Harmless 0 on desktop; real values on notched phones (viewport-fit=cover).
const TOP_INSET = 'calc(env(safe-area-inset-top, 0px) + 0.75rem)'
const BOTTOM_INSET = 'calc(env(safe-area-inset-bottom, 0px) + 1rem)'

const MODEL_LABELS = { auto: 'Auto', m3: 'MiniMax M3', gemma: 'Gemma 4', gptoss: 'GPT-OSS 120B' }

export default function App() {
  // Load conversations once and derive the active id from the SAME instance — a fresh
  // load (or legacy migration) mints new ids, so calling the loader twice would leave
  // activeId pointing at a conversation that isn't in state.
  const initialConvs = useRef(null)
  if (!initialConvs.current) initialConvs.current = loadConversations()
  const [conversations, setConversations] = useState(initialConvs.current)
  const [activeId, setActiveId] = useState(() => loadActiveId(initialConvs.current))
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [model, setModel] = useState(() => localStorage.getItem('model') || 'auto')
  const [style, setStyle] = useState(() => localStorage.getItem('style') || 'default')
  const [tab, setTab] = useState('chat')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [usage, setUsage] = useState(loadUsage)
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('theme')
    if (saved) return saved
    // Migrate the old boolean dark-mode pref into a theme.
    const wasDark = localStorage.getItem('darkMode') === 'true' ||
      (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    return wasDark ? 'dark' : 'light'
  })
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const darkMode = isDarkTheme(theme) // many conditionals below still key off this
  const [images, setImages] = useState([])              // uploaded: [{ data, mediaType }]
  const [imagePreviews, setImagePreviews] = useState([]) // matching data URLs for preview
  const MAX_IMAGES = 4
  const [error, setError] = useState(null)
  const [lastAttempt, setLastAttempt] = useState(null)
  const [webSearch, setWebSearch] = useState(() => localStorage.getItem('webSearch') === 'true')
  const [listening, setListening] = useState(false)
  const [doc, setDoc] = useState(null)          // { name, text, chars, truncated }
  const [docLoading, setDocLoading] = useState(false)
  const [speakingId, setSpeakingId] = useState(null) // id of the reply being read aloud
  const [copiedId, setCopiedId] = useState(null)     // id of the message just copied
  const [convSearch, setConvSearch] = useState('')   // sidebar conversation filter
  const [suggestions, setSuggestions] = useState([]) // follow-up question chips
  const suggestedForRef = useRef(null)               // last reply id we fetched for
  // Memory + personalization
  const [aboutYou, setAboutYou] = useState(() => localStorage.getItem('aboutYou') || '')
  const [customInstructions, setCustomInstructions] = useState(() => localStorage.getItem('customInstructions') || '')
  const [memoryEnabled, setMemoryEnabled] = useState(() => localStorage.getItem('memoryEnabled') !== 'false')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [memories, setMemories] = useState([])
  const [newMemory, setNewMemory] = useState('')
  const retrievedMemoryRef = useRef([])              // memories retrieved for the in-flight turn
  const extractedForRef = useRef(null)               // last reply id we extracted memory from
  const messagesEndRef = useRef(null)
  const messagesContainerRef = useRef(null)
  const fileInputRef = useRef(null)
  const docInputRef = useRef(null)
  const recognitionRef = useRef(null)
  const abortRef = useRef(null)                       // AbortController for the live stream

  // Phase 7 — shareable links. If the app is opened with ?s=<id>, we render a read-only
  // snapshot instead of the live app (see the early return below).
  const [shareId] = useState(() => shareIdFromUrl())
  const [sharedChat, setSharedChat] = useState(null)
  const [shareLoading, setShareLoading] = useState(!!shareId)
  const [shareNotFound, setShareNotFound] = useState(false)
  const [shareBusy, setShareBusy] = useState(false)   // creating a share link
  const [shareCopied, setShareCopied] = useState(false)
  const [shares, setShares] = useState(null)          // manage/revoke list (null = not loaded)

  // Accounts (Supabase Auth). Signed out → localStorage-only/private. Signed in →
  // cloud sync + memory + shares activate, scoped to this user by RLS.
  const [authUser, setAuthUser] = useState(null)
  const signedIn = !!authUser
  // Phase 2 (Stripe) will set this from the user's subscription row. Until then
  // everyone is on the free tier and the daily message cap applies.
  const isPro = false
  // Guard a send against the free-tier daily cap. Returns true if blocked (and shows
  // an upgrade nudge). Pro users are never blocked here.
  const blockedByLimit = () => {
    if (!isPro && overMessageLimit(usage, isPro)) {
      setError(`You've reached the free daily limit of ${dailyMessageLimit(false)} messages. It resets at midnight — or Pro (coming soon) lifts the cap.`)
      return true
    }
    return false
  }
  const [authOpen, setAuthOpen] = useState(false)     // sign-in modal
  const [authEmail, setAuthEmail] = useState('')
  const [authSent, setAuthSent] = useState(false)     // magic-link sent confirmation
  const [authMsg, setAuthMsg] = useState(null)        // error / status text

  useEffect(() => {
    if (!hasSupabase) return
    initAuth().then(setAuthUser)
    return onAuthChange(setAuthUser)
  }, [])

  const sendMagicLink = async () => {
    setAuthMsg(null)
    const email = authEmail.trim()
    if (!email) return
    const { error } = await signInWithEmail(email)
    if (error) setAuthMsg(error)
    else setAuthSent(true)
  }
  const doGoogle = async () => {
    setAuthMsg(null)
    const { error } = await signInWithGoogle()
    if (error) setAuthMsg(error)
  }
  const doSignOut = async () => {
    await signOut()
    setAuthUser(null)
    setAuthOpen(false)
  }

  useEffect(() => {
    if (!shareId) return
    let alive = true
    loadShare(shareId).then((data) => {
      if (!alive) return
      if (data) setSharedChat(data)
      else setShareNotFound(true)
      setShareLoading(false)
    })
    return () => { alive = false }
  }, [shareId])

  // Web Speech API — present on Chrome/Edge/Safari (incl. iOS), absent on Firefox.
  const speechSupported = typeof window !== 'undefined' &&
    (window.SpeechRecognition || window.webkitSpeechRecognition)

  // Keep the active id reachable inside async stream closures without stale capture.
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  const activeConv = conversations.find((c) => c.id === activeId) || conversations[0]
  const messages = activeConv ? activeConv.messages : []

  // setMessages shim: updates the active conversation's messages (and auto-titles it),
  // so the streaming code below stays unchanged from the single-history version.
  const setMessages = (updater) => {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== activeIdRef.current) return c
        const next = typeof updater === 'function' ? updater(c.messages) : updater
        const title = c.title === 'New chat' ? titleFromMessages(next) || c.title : c.title
        return { ...c, messages: next, title, updatedAt: Date.now() }
      })
    )
  }

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => { scrollToBottom() }, [messages])

  // Apply syntax highlighting + math rendering once a reply finishes streaming, then
  // bolt a "Run" button onto any Python code blocks (Phase 3 — Pyodide interpreter).
  useEffect(() => {
    if (loading) return
    enhanceMessages(messagesContainerRef.current)
    attachRunButtons(messagesContainerRef.current)
    attachArtifacts(messagesContainerRef.current)
  }, [messages, loading])

  // After a reply completes, fetch 3 follow-up suggestions (once per reply).
  useEffect(() => {
    if (loading) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant' || !last.content || last.content.length < 12) return
    if (suggestedForRef.current === last.id) return
    suggestedForRef.current = last.id
    fetchSuggestions(messages)
  }, [loading, messages]) // eslint-disable-line react-hooks/exhaustive-deps

  // After a reply completes, auto-extract durable user facts into memory (once per reply).
  useEffect(() => {
    if (!memoryEnabled || !memoryAvailable || !signedIn || loading) return
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant' || !last.content || last.content.length < 12) return
    if (extractedForRef.current === last.id) return
    extractedForRef.current = last.id
    autoExtractMemory(messages)
  }, [loading, messages, memoryEnabled]) // eslint-disable-line react-hooks/exhaustive-deps

  const autoExtractMemory = async (convMessages) => {
    try {
      const recent = convMessages.slice(-4).map((m) => ({ role: m.role, content: m.content || '' }))
      const res = await fetch('/api/memory-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: recent }),
      })
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data.facts)) {
        for (const f of data.facts) await storeMemory(f, { source: 'auto' })
      }
    } catch { /* best-effort */ }
  }

  const fetchSuggestions = async (convMessages) => {
    try {
      const recent = convMessages.slice(-6).map((m) => ({ role: m.role, content: m.content || '' }))
      const res = await fetch('/api/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: recent }),
      })
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data.suggestions)) setSuggestions(data.suggestions.slice(0, 3))
    } catch { /* best-effort; show nothing */ }
  }

  // Send arbitrary text (used by follow-up chips). Mirrors handleSubmit minus uploads.
  const sendText = async (text) => {
    if (loading || !text.trim()) return
    if (blockedByLimit()) return
    setSuggestions([])
    const userMessage = { id: Date.now(), role: 'user', content: text }
    const history = messages
    setMessages((prev) => [...prev, userMessage])
    if (!webSearch && !looksLikeImageRequest(text)) {
      const cached = getCached(cacheKey(model, history, text))
      if (cached) {
        setMessages((prev) => [...prev, { id: Date.now() + 1, role: 'assistant', content: cached, cached: true }])
        return
      }
    }
    await sendToModel(history, { text, images: [], document: null })
  }

  useEffect(() => {
    localStorage.setItem('theme', theme)
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.classList.toggle('dark', isDarkTheme(theme))
  }, [theme])

  useEffect(() => { saveConversations(conversations) }, [conversations])
  useEffect(() => { saveActiveId(activeId) }, [activeId])
  useEffect(() => { localStorage.setItem('model', model) }, [model])
  useEffect(() => { localStorage.setItem('style', style) }, [style])
  useEffect(() => { localStorage.setItem('aboutYou', aboutYou) }, [aboutYou])
  useEffect(() => { localStorage.setItem('customInstructions', customInstructions) }, [customInstructions])
  useEffect(() => { localStorage.setItem('memoryEnabled', memoryEnabled) }, [memoryEnabled])

  // Load personalization settings from Supabase once signed in (cloud overrides local).
  useEffect(() => {
    if (!memoryAvailable || !signedIn) return
    loadSettings().then((s) => {
      if (!s) return
      if (s.about_you != null) setAboutYou(s.about_you)
      if (s.custom_instructions != null) setCustomInstructions(s.custom_instructions)
      if (s.memory_enabled != null) setMemoryEnabled(s.memory_enabled)
    })
  }, [signedIn]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { localStorage.setItem('webSearch', webSearch) }, [webSearch])

  // Voice input via the Web Speech API. Live interim transcript fills the input;
  // tapping the mic again (or the API ending) stops it.
  const toggleVoice = () => {
    if (!speechSupported) return
    if (listening) { recognitionRef.current?.stop(); return }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    const rec = new SR()
    rec.lang = 'en-US'
    rec.interimResults = true
    rec.continuous = false
    const base = input ? input.trim() + ' ' : ''
    rec.onresult = (e) => {
      let transcript = ''
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript
      setInput(base + transcript)
    }
    rec.onend = () => { setListening(false); recognitionRef.current = null }
    rec.onerror = () => { setListening(false); recognitionRef.current = null }
    recognitionRef.current = rec
    setListening(true)
    rec.start()
  }

  // Text-to-speech via the browser's built-in SpeechSynthesis. Reads a reply aloud;
  // tapping again (or starting another) stops it.
  const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window
  const speak = (id, text) => {
    if (!ttsSupported) return
    window.speechSynthesis.cancel()
    if (speakingId === id) { setSpeakingId(null); return }
    // Strip markdown so it reads naturally, not "asterisk asterisk".
    const clean = String(text || '')
      .replace(/[#*`_>]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .slice(0, 4000)
    const u = new SpeechSynthesisUtterance(clean)
    u.onend = () => setSpeakingId((cur) => (cur === id ? null : cur))
    u.onerror = () => setSpeakingId((cur) => (cur === id ? null : cur))
    setSpeakingId(id)
    window.speechSynthesis.speak(u)
  }

  // Document upload: parse client-side to text and attach it to the next message.
  const handleDocUpload = async (e) => {
    const file = e.target.files[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    if (!isSupportedDocument(file)) {
      setError('Unsupported file. Try PDF, Word (.docx), CSV, or a text file.')
      return
    }
    setDocLoading(true)
    setError(null)
    try {
      const parsed = await parseDocument(file)
      setDoc(parsed)
      // Phase 2b RAG: large docs get chunked + embedded so we can retrieve only the
      // relevant parts later. Warm the index now (best-effort) so the first question
      // doesn't wait on it.
      if (parsed.text.length > RAG_THRESHOLD) {
        buildIndex(docId(parsed.name, parsed.text), parsed.text).catch(() => {})
      }
    } catch (err) {
      setError(err.message || 'Could not read that document.')
      setDoc(null)
    } finally {
      setDocLoading(false)
    }
  }

  // Supabase: once signed in, pull the user's remote conversations and merge with
  // local. Signed-out users stay purely on localStorage.
  const [synced, setSynced] = useState(false)
  useEffect(() => {
    if (!hasSupabase || !signedIn) { setSynced(true); return }
    setSynced(false)
    syncConversationsDown(conversations).then((merged) => {
      setConversations(merged)
      setSynced(true)
    })
  }, [signedIn]) // eslint-disable-line react-hooks/exhaustive-deps

  // Push the active conversation to Supabase whenever it changes (debounced).
  const pushTimerRef = useRef(null)
  useEffect(() => {
    if (!synced || !hasSupabase || !signedIn) return
    clearTimeout(pushTimerRef.current)
    pushTimerRef.current = setTimeout(() => {
      const conv = conversations.find((c) => c.id === activeIdRef.current)
      if (conv) syncConversationUp(conv)
    }, 1500)
  }, [conversations, synced])

  // Shrink an image to <= maxDim on its longest side and re-encode as JPEG. Phone photos
  // are several MB; this keeps vision uploads fast and, crucially, small enough for the
  // FLUX.1 Kontext inline photo-edit limit. Falls back to the raw file if canvas fails.
  const downscaleImage = (file, maxDim = 1024, quality = 0.82) =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        URL.revokeObjectURL(url)
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
        const w = Math.round(img.width * scale)
        const h = Math.round(img.height * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        resolve({ dataUrl, data: dataUrl.split(',')[1], mediaType: 'image/jpeg' })
      }
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')) }
      img.src = url
    })

  const readAsDataURL = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (event) => resolve(event.target.result)
      reader.onerror = () => reject(new Error('read failed'))
      reader.readAsDataURL(file)
    })

  // Accept several images at once, up to MAX_IMAGES total. Each is downscaled (falling
  // back to the raw file), then appended to the existing selection.
  const handleImageUpload = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // allow re-selecting the same file(s)
    if (!files.length) return
    const slots = Math.max(0, MAX_IMAGES - images.length)
    if (slots === 0) {
      setError(`You can attach up to ${MAX_IMAGES} images.`)
      return
    }
    const picked = files.slice(0, slots)
    const added = []
    for (const file of picked) {
      try {
        const { dataUrl, data, mediaType } = await downscaleImage(file)
        added.push({ dataUrl, img: { data, mediaType } })
      } catch {
        try {
          const dataUrl = await readAsDataURL(file)
          added.push({ dataUrl, img: { data: dataUrl.split(',')[1], mediaType: file.type } })
        } catch { /* skip unreadable file */ }
      }
    }
    if (added.length) {
      setImagePreviews((prev) => [...prev, ...added.map((a) => a.dataUrl)])
      setImages((prev) => [...prev, ...added.map((a) => a.img)])
    }
  }

  // Remove one selected image (by index) before sending.
  const removeImage = (idx) => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
    setImagePreviews((prev) => prev.filter((_, i) => i !== idx))
  }

  // Core send routine. `history` is the message list to send as context,
  // `payload` is the new turn (text + optional image). Reused by submit and retry.
  const sendToModel = async (history, payload) => {
    setError(null)
    setLoading(true)

    // Retrieve relevant long-term memories for this turn (best-effort, time-boxed so the
    // first message stays responsive while the embedding model downloads on first use).
    let memForTurn = []
    if (memoryEnabled && memoryAvailable && signedIn && payload.text) {
      const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))])
      const mems = await withTimeout(retrieveMemories(payload.text, 5), 2500)
      if (Array.isArray(mems)) memForTurn = mems.map((m) => m.text)
    }
    retrievedMemoryRef.current = memForTurn

    // Phase 2b — Document RAG. Identify the document in play this turn (freshly attached,
    // else the most recent one in history) and, if it's large, retrieve only the chunks
    // relevant to the question instead of sending the whole thing. Time-boxed: if the
    // embedding index isn't ready, degrade to the document's head so the reply stays
    // snappy. Small docs keep the simple full-text path below.
    const lastDoc = [...history].reverse().find((m) => m.docText)
    const activeDocText = payload.document?.text || lastDoc?.docText
    const activeDocName = payload.document?.name || lastDoc?.docName
    const ragActive = activeDocText && activeDocText.length > RAG_THRESHOLD
    let outgoingDoc = payload.document
    if (ragActive) {
      const id = docId(activeDocName, activeDocText)
      const query = payload.text || activeDocName || ''
      try {
        const chunks = await Promise.race([
          retrieveChunks(id, activeDocText, query, 4),
          new Promise((r) => setTimeout(() => r(null), 6000)),
        ])
        outgoingDoc = {
          name: activeDocName,
          text: (chunks && chunks.length)
            ? chunks.join('\n\n---\n\n')
            : activeDocText.slice(0, RAG_THRESHOLD), // index not ready yet
        }
      } catch (_) {
        outgoingDoc = { name: activeDocName, text: activeDocText.slice(0, RAG_THRESHOLD) }
      }
    }

    // Create a placeholder assistant message we'll fill in as tokens stream in.
    const assistantId = Date.now() + 1
    let appended = false        // have we added the placeholder to the list yet?
    let accumulated = ''        // full text so far (for error-rollback decisions)
    let streamedText = ''       // text-only content (for caching)
    let producedImage = false   // did this turn generate an image?
    let routedModel = null      // which model the backend actually used
    let streamError = null      // terminal error reported by the backend

    const ensureAssistant = () => {
      if (appended) return
      appended = true
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: 'assistant', content: '' },
      ])
    }

    const appendDelta = (text) => {
      ensureAssistant()
      accumulated += text
      streamedText += text
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: m.content + text } : m
        )
      )
    }

    // AI-generated image: attach it to the assistant bubble as a data URL.
    const setAssistantImage = (b64, mediaType) => {
      ensureAssistant()
      accumulated += '[image]'
      producedImage = true
      const url = `data:${mediaType || 'image/jpeg'};base64,${b64}`
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, image: url } : m))
      )
    }

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Re-attach any document text from prior turns so follow-ups keep context.
          // Large (RAG) docs are NOT re-dumped here — that would defeat retrieval; their
          // relevant excerpts ride along in `document` below instead.
          messages: history.map((m) => {
            if (!m.docText) return { role: m.role, content: m.content }
            if (m.docText.length > RAG_THRESHOLD) {
              return { role: m.role, content: `${m.content}\n\n[Attached document: ${m.docName}]` }
            }
            return { role: m.role, content: `${m.content}\n\n[Attached document: ${m.docName}]\n${m.docText}` }
          }),
          newMessage: payload.text,
          images: payload.images,
          document: outgoingDoc,
          model: model,
          webSearch: webSearch,
          style: style,
          memory: memForTurn,
          customInstructions: customInstructions,
          aboutYou: aboutYou,
        }),
      })

      // Non-OK before streaming started (e.g. 400/500) — body may be JSON or NDJSON.
      if (!response.ok || !response.body) {
        let errMsg = 'Failed to get a response.'
        try {
          const data = await response.json()
          errMsg = data.error || errMsg
        } catch (_) { /* ignore parse failures */ }
        setError(errMsg)
        setLastAttempt({ history, payload })
        return
      }

      // Read the NDJSON stream: one JSON object per line.
      //   { delta }  -> append token
      //   { image }  -> AI-generated image
      //   { done }   -> terminal success (carries routed provider/model)
      //   { error }  -> terminal failure
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      const handleLine = (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        let evt
        try { evt = JSON.parse(trimmed) } catch { return }
        if (evt.delta) appendDelta(evt.delta)
        else if (evt.image) setAssistantImage(evt.image, evt.mediaType)
        else if (evt.error) streamError = evt.error
        else if (evt.done) routedModel = evt.model || null
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n')) >= 0) {
          handleLine(buffer.slice(0, idx))
          buffer = buffer.slice(idx + 1)
        }
      }
      if (buffer.length) handleLine(buffer)

      if (streamError) {
        // If nothing streamed, surface the error banner + retry. If we already
        // streamed partial content, keep what we got and append a note inline.
        if (accumulated) {
          appendDelta(`\n\n⚠️ ${streamError}`)
          setLastAttempt(null)
        } else {
          setError(streamError)
          setLastAttempt({ history, payload })
        }
      } else {
        setLastAttempt(null)
        // Tag the reply with the model that actually answered (useful in Auto mode).
        if (appended && routedModel) {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, via: routedModel } : m))
          )
        }
        // Usage: one chat request, plus an image if one was generated.
        setUsage(bumpUsage({ chat: 1, image: producedImage ? 1 : 0 }))
        // Cache plain text answers so identical prompts return instantly next time.
        // Never cache web-search answers — they're time-sensitive.
        if (!producedImage && !(payload.images && payload.images.length) && !webSearch && streamedText.trim()) {
          setCached(cacheKey(model, history, payload.text), streamedText)
        }
      }
    } catch (err) {
      // User pressed Stop: keep whatever streamed, no error.
      if (err.name === 'AbortError') {
        setLastAttempt(null)
      } else if (accumulated) {
        // Network drop mid-stream: keep partial content.
        appendDelta('\n\n⚠️ Connection interrupted.')
      } else {
        setError('Network error — check your connection and try again.')
        setLastAttempt({ history, payload })
      }
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }

  const stopGeneration = () => abortRef.current?.abort()

  // Data-URL preview -> { data, mediaType }. Legacy messages stored a single `image`;
  // newer ones store an `images` array. previewsOf() unifies both.
  const dataUrlToImage = (p) => {
    const [meta, b64] = p.split(',')
    const mediaType = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg'
    return { data: b64, mediaType }
  }
  const previewsOf = (m) =>
    (m.images && m.images.length ? m.images : (m.image ? [m.image] : []))
      .filter((p) => typeof p === 'string' && p.startsWith('data:'))

  // Reconstruct a send payload (text + images + document) from a stored user message,
  // used by regenerate and edit.
  const payloadFromUserMessage = (m) => {
    const document = m.docText ? { name: m.docName, text: m.docText } : null
    return { text: m.content || '', images: previewsOf(m).map(dataUrlToImage), document }
  }

  // Regenerate: drop the latest assistant reply and re-send the last user turn.
  const regenerateLast = () => {
    if (loading) return
    const msgs = messages
    let userIdx = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { userIdx = i; break }
    }
    if (userIdx === -1) return
    const history = msgs.slice(0, userIdx)
    const payload = payloadFromUserMessage(msgs[userIdx])
    setSuggestions([])
    setMessages(() => msgs.slice(0, userIdx + 1)) // keep the user msg, drop old reply
    sendToModel(history, payload)
  }

  // Edit: pull a user message back into the composer and truncate the chat to before it.
  const editMessage = (id) => {
    if (loading) return
    const idx = messages.findIndex((m) => m.id === id)
    if (idx === -1) return
    const m = messages[idx]
    setInput(m.content || '')
    const previews = previewsOf(m)
    if (previews.length) {
      setImagePreviews(previews)
      setImages(previews.map(dataUrlToImage))
    }
    if (m.docText) setDoc({ name: m.docName, text: m.docText, chars: m.docText.length, truncated: false })
    setMessages(() => messages.slice(0, idx))
  }

  // ---- Settings / memory management ----
  const openSettings = () => {
    setSettingsOpen(true)
    warmEmbedder() // start the embedding model download in the background
    if (memoryAvailable) listMemories().then(setMemories)
  }
  const persistSettings = () => {
    saveSettings({ about_you: aboutYou, custom_instructions: customInstructions, memory_enabled: memoryEnabled })
  }
  const removeMemory = async (id) => {
    await deleteMemory(id)
    setMemories((ms) => ms.filter((m) => m.id !== id))
  }
  const addManualMemory = async () => {
    const t = newMemory.trim()
    if (!t) return
    setNewMemory('')
    await storeMemory(t, { source: 'manual' })
    if (memoryAvailable) listMemories().then(setMemories)
  }

  const copyMessage = (id, text) => {
    if (!navigator.clipboard) return
    navigator.clipboard.writeText(text || '').then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500)
    }).catch(() => {})
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (loading) return // dedupe: never run two requests at once
    if (!input.trim() && !images.length && !doc) return
    if (blockedByLimit()) return

    const text = input
    const userMessage = {
      id: Date.now(),
      role: 'user',
      content: text,
      images: imagePreviews.length ? imagePreviews : undefined,
      // Keep the document text on the message so follow-up turns retain context,
      // but display only the filename chip (docText is hidden from the bubble).
      docName: doc ? doc.name : undefined,
      docText: doc ? doc.text : undefined,
    }

    // Snapshot the context (before adding this turn) and the new payload.
    const history = messages
    const payload = { text, images, document: doc ? { name: doc.name, text: doc.text } : null }

    setMessages((prev) => [...prev, userMessage])
    setInput('')
    setImages([])
    setImagePreviews([])
    setDoc(null)
    setSuggestions([])

    // Manual memory: "remember (that/this) ..." stores the fact explicitly.
    if (memoryEnabled && memoryAvailable) {
      const rem = text.match(/^\s*remember\s+(?:that\s+|this\s*[:,]?\s+|[:,]\s*)?(.+)/i)
      if (rem && rem[1]) storeMemory(rem[1].trim(), { source: 'manual' })
    }

    // Cache hit: serve an identical text-only, non-image, non-doc prompt instantly.
    if (!images.length && !doc && !webSearch && !looksLikeImageRequest(text)) {
      const cached = getCached(cacheKey(model, history, text))
      if (cached) {
        setMessages((prev) => [
          ...prev,
          { id: Date.now() + 1, role: 'assistant', content: cached, cached: true },
        ])
        return
      }
    }

    await sendToModel(history, payload)
  }

  const handleRetry = () => {
    if (lastAttempt) sendToModel(lastAttempt.history, lastAttempt.payload)
  }

  const clearHistory = () => {
    if (window.confirm('Clear this conversation?')) setMessages([])
  }

  // Phase 7 — create a shareable read-only link for the active conversation and copy it.
  const handleShare = async () => {
    if (shareBusy || !activeConv || !(activeConv.messages || []).length) return
    setShareBusy(true)
    setError(null)
    try {
      const id = await createShare(activeConv)
      const url = shareUrl(id)
      try { await navigator.clipboard.writeText(url) } catch { /* clipboard blocked */ }
      setShareCopied(true)
      setTimeout(() => setShareCopied((v) => (v ? false : v)), 2500)
    } catch (err) {
      setError(err.message || 'Could not create a share link.')
    } finally {
      setShareBusy(false)
    }
    refreshShares()
  }

  // Load the list of existing shares for the manage/revoke UI (called when Settings opens
  // and after creating/revoking a share).
  const refreshShares = async () => {
    setShares(await listShares())
  }
  useEffect(() => { if (settingsOpen) refreshShares() }, [settingsOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  // Revoke a share: delete it and drop it from the list (optimistic, reverts on failure).
  const revokeShare = async (id) => {
    setShares((prev) => (prev || []).filter((s) => s.id !== id))
    const ok = await deleteShare(id)
    if (!ok) { setError('Could not revoke that link.'); refreshShares() }
  }

  const copyShareUrl = async (id) => {
    try { await navigator.clipboard.writeText(shareUrl(id)) } catch { /* clipboard blocked */ }
  }

  // ---- Conversation management ----
  const startNewChat = () => {
    const c = newConversation([])
    setConversations((prev) => [c, ...prev])
    setActiveId(c.id)
    setSidebarOpen(false)
    setError(null)
  }

  const selectChat = (id) => {
    setActiveId(id)
    setSidebarOpen(false)
    setError(null)
  }

  const deleteChat = (id) => {
    syncDeleteConversation(id)
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id)
      if (next.length === 0) {
        const fresh = newConversation([])
        setActiveId(fresh.id)
        return [fresh]
      }
      if (id === activeIdRef.current) setActiveId(next[0].id)
      return next
    })
  }

  const imageLimitHit = usage.image >= IMAGE_DAILY_SOFT_LIMIT

  // Phase 7 — read-only shared view takes over the whole app when ?s=<id> is present.
  if (shareId) {
    return (
      <div className={darkMode ? 'dark' : ''}>
        <SharedChat chat={sharedChat} loading={shareLoading} notFound={shareNotFound} />
      </div>
    )
  }

  return (
    <div className={darkMode ? 'dark' : ''}>
      <div className="flex flex-col h-[100dvh] overflow-x-hidden bg-[var(--bg)] text-[var(--text)]">
        {/* Header */}
        <div
          className="bg-[var(--surface)] border-[var(--border)] border-b px-2 sm:px-4 pb-3 flex items-center justify-between gap-1"
          style={{ paddingTop: TOP_INSET }}
        >
          <div className="flex items-center gap-1">
            {tab === 'chat' && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="p-1.5 sm:p-2 rounded-lg bg-[var(--surface-2)] text-[var(--text)]"
                aria-label="Chat history"
              >
                <Menu size={18} />
              </button>
            )}
            <div className="flex items-center gap-1.5 px-1 font-semibold text-[var(--text)] select-none">
              <MessageSquare size={18} className="text-[var(--accent)]" />
              <span>FreeGPT</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {tab === 'chat' && messages.length > 0 && (
              <button
                onClick={handleShare}
                disabled={shareBusy}
                className="flex items-center gap-1 p-1.5 sm:px-2.5 sm:py-2 rounded-lg bg-[var(--surface-2)] text-[var(--text)] disabled:opacity-50"
                aria-label="Share this chat"
                title="Create a read-only share link"
              >
                {shareBusy ? <Loader2 size={18} className="animate-spin" />
                  : shareCopied ? <Check size={18} className="text-green-500" />
                  : <Share2 size={18} />}
                {shareCopied && <span className="hidden sm:inline text-xs">Link copied</span>}
              </button>
            )}
            {hasSupabase && (
              signedIn ? (
                <button
                  onClick={doSignOut}
                  className="flex items-center gap-1 p-1.5 sm:px-2.5 sm:py-2 rounded-lg bg-[var(--surface-2)] text-[var(--text)] hover:opacity-80"
                  aria-label="Sign out"
                  title={`Signed in as ${authUser?.email || 'you'} — tap to sign out`}
                >
                  <LogOut size={18} />
                  <span className="hidden md:inline text-xs max-w-[10rem] truncate">{authUser?.email}</span>
                </button>
              ) : (
                <button
                  onClick={() => { setAuthOpen(true); setAuthSent(false); setAuthMsg(null) }}
                  className="flex items-center gap-1 p-1.5 sm:px-2.5 sm:py-2 rounded-lg bg-[var(--accent)] text-[var(--accent-text)] hover:opacity-90"
                  aria-label="Sign in"
                  title="Sign in to sync across devices"
                >
                  <LogIn size={18} />
                  <span className="hidden sm:inline text-xs font-medium">Sign in</span>
                </button>
              )
            )}
            <button
              onClick={openSettings}
              className="p-1.5 sm:p-2 rounded-lg bg-[var(--surface-2)] text-[var(--text)]"
              aria-label="Settings & memory"
            >
              <Settings size={18} />
            </button>
            <div className="relative">
              <button
                onClick={() => setThemeMenuOpen((o) => !o)}
                className="p-1.5 sm:p-2 rounded-lg bg-[var(--surface-2)] text-[var(--text)]"
                aria-label="Change theme"
              >
                <Palette size={18} />
              </button>
              {themeMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setThemeMenuOpen(false)} />
                  <div className="absolute right-0 mt-1 z-50 w-44 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl p-1">
                    {THEMES.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => { setTheme(t.id); setThemeMenuOpen(false) }}
                        className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-left ${
                          theme === t.id ? 'bg-[var(--surface-2)] font-medium' : ''
                        } text-[var(--text)] hover:bg-[var(--surface-2)]`}
                      >
                        <span
                          className="w-4 h-4 rounded-full border border-[var(--border)] shrink-0"
                          style={{ background: t.swatch }}
                        />
                        {t.name}
                        {theme === t.id && <span className="ml-auto text-xs text-[var(--accent)]">●</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {tab === 'chat' && (
              <button
                onClick={clearHistory}
                className="p-1.5 sm:p-2 rounded-lg bg-[var(--surface-2)] text-red-500 hover:opacity-80"
                aria-label="Clear chat"
              >
                <Trash2 size={18} />
              </button>
            )}
          </div>
        </div>

        {tab === 'chat' && (
        <>
        {/* Model Selector + usage */}
        <div className="bg-[var(--surface)] border-[var(--border)] border-b px-4 py-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-[var(--muted)]">Model:</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="px-3 py-1 rounded-lg text-sm border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)]"
            >
              <option value="auto">Auto — smart routing</option>
              <option value="m3">MiniMax M3 — vision</option>
              <option value="gemma">Gemma 4 — vision + images</option>
              <option value="gptoss">GPT-OSS 120B — smartest</option>
            </select>
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              className="px-3 py-1 rounded-lg text-sm border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)]"
              title="Response style"
            >
              <option value="default">Balanced</option>
              <option value="quick">Quick answer</option>
              <option value="info">Info only (no code)</option>
              <option value="code">Code suggestions</option>
            </select>
            <span
              className={`ml-auto text-xs ${imageLimitHit ? 'text-red-500 font-medium' : 'text-[var(--muted)]'}`}
              title={`Conversations in your sidebar · images generated today (soft-limit ${IMAGE_DAILY_SOFT_LIMIT}/day to avoid throttling).`}
            >
              {conversations.length} {conversations.length === 1 ? 'chat' : 'chats'} · {usage.image} imgs today{imageLimitHit ? ' ⚠' : ''}
            </span>
          </div>
        </div>

        {/* Messages */}
        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 space-y-4 bg-[var(--bg)]">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full text-center text-[var(--muted)]">
              <div>
                <p className="text-lg mb-2">No messages yet</p>
                <p className="text-sm">Start typing to begin a conversation</p>
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, mi) => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[88%] sm:max-w-[80%] min-w-0 px-4 py-2 rounded-lg break-words ${
                      msg.role === 'user'
                        ? 'bg-[var(--user-bubble)] text-[var(--user-text)]'
                        : 'bg-[var(--assistant-bubble)] text-[var(--assistant-text)]'
                    }`}
                  >
                    {/* Uploaded photo(s) — array on new messages, single `image` on legacy ones. */}
                    {(msg.images && msg.images.length ? msg.images : (msg.role === 'user' && msg.image ? [msg.image] : [])).length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-2">
                        {(msg.images && msg.images.length ? msg.images : [msg.image]).map((src, i) => (
                          <img
                            key={i}
                            src={src}
                            alt="uploaded"
                            className="max-w-[8rem] max-h-32 rounded"
                            onError={(e) => { e.currentTarget.style.display = 'none' }}
                          />
                        ))}
                      </div>
                    )}
                    {/* AI-generated image (assistant only) — with a load-failure note. */}
                    {msg.role === 'assistant' && msg.image && (
                      <>
                        <img
                          src={msg.image}
                          alt="generated image"
                          className="max-w-xs rounded mb-2"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none'
                            const note = e.currentTarget.nextElementSibling
                            if (note) note.style.display = 'block'
                          }}
                        />
                        <p style={{ display: 'none' }} className="text-xs text-[var(--muted)] mb-2">
                          ⚠️ The image couldn't load. Use Retry below to generate it again.
                        </p>
                      </>
                    )}
                    {msg.docName && (
                      <div className="flex items-center gap-1.5 mb-2 text-xs opacity-90">
                        <FileUp size={13} /> <span className="truncate">{msg.docName}</span>
                      </div>
                    )}
                    {msg.role === 'assistant' ? (
                      <div className="text-sm prose-sm md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                    ) : (
                      msg.content && <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                    )}
                    {msg.role === 'assistant' && (msg.via || msg.cached) && (
                      <p className={`text-[10px] mt-1 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                        {msg.cached ? 'cached' : `via ${MODEL_LABELS[msg.via] || msg.via}`}
                      </p>
                    )}
                    {msg.role === 'assistant' && msg.content && msg.content.length > 20 && !loading && (
                      <div className="flex gap-1.5 mt-2 pt-1.5 border-t border-current/10">
                        {ttsSupported && (
                          <button
                            onClick={() => speak(msg.id, msg.content)}
                            className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded ${
                              speakingId === msg.id
                                ? 'bg-[var(--accent)] text-[var(--accent-text)]'
                                : 'bg-[var(--surface-2)] text-[var(--muted)] hover:opacity-80'
                            }`}
                            title={speakingId === msg.id ? 'Stop reading' : 'Read aloud'}
                          >
                            {speakingId === msg.id ? <Square size={12} /> : <Volume2 size={12} />}
                            {speakingId === msg.id ? 'Stop' : 'Listen'}
                          </button>
                        )}
                        <button
                          onClick={() => exportReplyWord(msg.content)}
                          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--muted)] hover:opacity-80"
                          title="Download as Word document"
                        >
                          <FileText size={12} /> Word
                        </button>
                        <button
                          onClick={() => { if (!exportReplyPdf(msg.content)) alert('Allow pop-ups to save PDF.') }}
                          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--muted)] hover:opacity-80"
                          title="Open as PDF (print/save)"
                        >
                          <Download size={12} /> PDF
                        </button>
                        <button
                          onClick={() => copyMessage(msg.id, msg.content)}
                          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--muted)] hover:opacity-80"
                          title="Copy reply"
                        >
                          {copiedId === msg.id ? <Check size={12} /> : <Copy size={12} />}
                          {copiedId === msg.id ? 'Copied' : 'Copy'}
                        </button>
                        {mi === messages.length - 1 && (
                          <button
                            onClick={regenerateLast}
                            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--muted)] hover:opacity-80"
                            title="Regenerate this reply"
                          >
                            <RefreshCw size={12} /> Retry
                          </button>
                        )}
                      </div>
                    )}
                    {msg.role === 'user' && !loading && (
                      <div className="flex justify-end mt-1">
                        <button
                          onClick={() => editMessage(msg.id)}
                          className="flex items-center gap-1 text-[10px] opacity-70 hover:opacity-100"
                          title="Edit & resend"
                        >
                          <Pencil size={11} /> Edit
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {loading && messages[messages.length - 1]?.role !== 'assistant' && (
                <div className="flex justify-start">
                  <div className="bg-[var(--assistant-bubble)] px-4 py-2 rounded-lg">
                    <div className="flex gap-1">
                      <div className="w-2 h-2 rounded-full bg-[var(--muted)] animate-bounce"></div>
                      <div className="w-2 h-2 rounded-full bg-[var(--muted)] animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                      <div className="w-2 h-2 rounded-full bg-[var(--muted)] animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                    </div>
                  </div>
                </div>
              )}
              {!loading && suggestions.length > 0 && (
                <div className="flex flex-col items-start gap-1.5 pt-1">
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => sendText(s)}
                      className="text-xs text-left px-3 py-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--accent)] hover:bg-[var(--surface-2)]"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}

          {error && (
            <div className="flex justify-start">
              <div
                role="alert"
                className={`max-w-xs px-4 py-3 rounded-lg border ${
                  darkMode
                    ? 'bg-red-950/40 border-red-800 text-red-200'
                    : 'bg-red-50 border-red-200 text-red-700'
                }`}
              >
                <p className="text-sm mb-2">{error}</p>
                <div className="flex gap-2">
                  {lastAttempt && (
                    <button
                      onClick={handleRetry}
                      disabled={loading}
                      className={`text-xs font-medium px-3 py-1 rounded ${
                        darkMode
                          ? 'bg-red-800 text-red-100 hover:bg-red-700 disabled:opacity-50'
                          : 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50'
                      }`}
                    >
                      Retry
                    </button>
                  )}
                  <button
                    onClick={() => setError(null)}
                    className={`text-xs font-medium px-3 py-1 rounded ${
                      darkMode
                        ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                    }`}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input Area */}
        <div
          className="bg-[var(--surface)] border-[var(--border)] border-t px-4 pt-4"
          style={{ paddingBottom: BOTTOM_INSET }}
        >
          {imagePreviews.length > 0 && (
            <div className="mb-3 flex items-center gap-2 flex-wrap">
              {imagePreviews.map((src, i) => (
                <div key={i} className="relative">
                  <img src={src} alt="preview" className="h-16 w-16 object-cover rounded-lg" />
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute -top-1.5 -right-1.5 rounded-full p-0.5 bg-[var(--surface)] border border-[var(--border)] text-red-500 shadow"
                    aria-label="Remove image"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {(doc || docLoading) && (
            <div className="mb-3 flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[var(--surface-2)]">
              <div className="flex items-center gap-2 min-w-0">
                {docLoading
                  ? <Loader2 size={16} className="animate-spin shrink-0" />
                  : <FileUp size={16} className="shrink-0 text-[var(--accent)]" />}
                <span className="text-sm truncate text-[var(--text)]">
                  {docLoading ? 'Reading document…' : `${doc.name}${doc.truncated ? ' (truncated)' : ''}`}
                </span>
              </div>
              {doc && (
                <button
                  onClick={() => setDoc(null)}
                  className="text-sm px-2 py-1 rounded shrink-0 bg-[var(--surface)] text-red-500"
                >
                  Remove
                </button>
              )}
            </div>
          )}
          {/* Web search toggle */}
          <div className="mb-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setWebSearch((v) => !v)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                webSearch
                  ? 'bg-[var(--accent)] text-[var(--accent-text)] border-[var(--accent)]'
                  : 'bg-[var(--surface-2)] text-[var(--muted)] border-[var(--border)]'
              }`}
              title="Search the web for current information"
            >
              <Globe size={13} /> Web search {webSearch ? 'on' : 'off'}
            </button>
          </div>
          <form onSubmit={handleSubmit} className="flex gap-1.5">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageUpload}
              accept="image/*"
              multiple
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={`p-2 rounded-lg shrink-0 bg-[var(--surface-2)] text-[var(--text)] hover:opacity-80`}
              aria-label="Upload image"
            >
              <Paperclip size={20} />
            </button>
            <input
              type="file"
              ref={docInputRef}
              onChange={handleDocUpload}
              accept=".pdf,.docx,.csv,.txt,.md,.markdown,.json,.log,text/*"
              className="hidden"
            />
            <button
              type="button"
              onClick={() => docInputRef.current?.click()}
              disabled={docLoading}
              className={`p-2 rounded-lg shrink-0 bg-[var(--surface-2)] text-[var(--text)] hover:opacity-80 disabled:opacity-50`}
              aria-label="Upload document"
            >
              {docLoading ? <Loader2 size={20} className="animate-spin" /> : <FileUp size={20} />}
            </button>
            {speechSupported && (
              <button
                type="button"
                onClick={toggleVoice}
                className={`p-2 rounded-lg shrink-0 ${
                  listening
                    ? 'bg-red-500 text-white animate-pulse'
                    : darkMode ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                }`}
                aria-label={listening ? 'Stop voice input' : 'Start voice input'}
              >
                <Mic size={20} />
              </button>
            )}
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                listening ? 'Listening…'
                : imagePreviews.length ? 'Ask about the photo(s), or say "show this in full summer bloom"…'
                : 'Type a message...'
              }
              className="flex-1 min-w-0 px-4 py-2 rounded-lg border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)] placeholder:text-[var(--muted)]"
              disabled={loading}
            />
            {loading ? (
              <button
                type="button"
                onClick={stopGeneration}
                className="p-2 rounded-lg shrink-0 bg-red-500 text-white hover:bg-red-600"
                aria-label="Stop generating"
              >
                <Square size={20} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() && !images.length && !doc}
                className={`p-2 rounded-lg shrink-0 ${
                  !input.trim() && !images.length && !doc
                    ? 'bg-[var(--surface-2)] text-[var(--muted)] opacity-60'
                    : 'bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)]'
                }`}
                aria-label="Send message"
              >
                <Send size={20} />
              </button>
            )}
          </form>
        </div>
        </>
        )}

        {/* Chat history sidebar */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-30 flex">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setSidebarOpen(false)}
            />
            <div
              className="relative w-72 max-w-[80%] h-full flex flex-col shadow-xl bg-[var(--surface)] text-[var(--text)]"
              style={{ paddingTop: TOP_INSET }}
            >
              <div className="flex items-center justify-between px-4 pb-3 border-b border-[var(--border)]">
                <span className="font-semibold text-[var(--text)]">Chats</span>
                <button
                  onClick={() => setSidebarOpen(false)}
                  className="p-1.5 rounded-lg text-[var(--muted)] hover:bg-[var(--surface-2)]"
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="p-3 flex flex-col gap-2 border-b border-[var(--border)]">
                <button
                  onClick={startNewChat}
                  className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)]"
                >
                  <Plus size={16} /> New chat
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => exportWord(activeConv?.title || 'chat', messages)}
                    disabled={messages.length === 0}
                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40 bg-[var(--surface-2)] text-[var(--text)] hover:opacity-80"
                  >
                    <FileText size={14} /> Word
                  </button>
                  <button
                    onClick={() => { if (!exportPdf(activeConv?.title || 'chat', messages)) alert('Allow pop-ups to export PDF.') }}
                    disabled={messages.length === 0}
                    className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40 bg-[var(--surface-2)] text-[var(--text)] hover:opacity-80"
                  >
                    <Printer size={14} /> PDF
                  </button>
                </div>
              </div>

              <div className="px-3 pt-2 pb-1">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
                  <input
                    type="text"
                    value={convSearch}
                    onChange={(e) => setConvSearch(e.target.value)}
                    placeholder="Search chats…"
                    className="w-full pl-8 pr-2 py-1.5 rounded-lg text-sm border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)] placeholder:text-[var(--muted)]"
                  />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-2">
                {conversations
                  .filter((c) => {
                    const q = convSearch.trim().toLowerCase()
                    if (!q) return true
                    if ((c.title || '').toLowerCase().includes(q)) return true
                    return (c.messages || []).some((m) => (m.content || '').toLowerCase().includes(q))
                  })
                  .map((c) => (
                  <div
                    key={c.id}
                    className={`group flex items-center gap-1 rounded-lg mb-1 ${
                      c.id === activeId ? 'bg-[var(--surface-2)]' : ''
                    }`}
                  >
                    <button
                      onClick={() => selectChat(c.id)}
                      className="flex-1 text-left px-3 py-2 text-sm truncate text-[var(--text)]"
                    >
                      {c.title || 'New chat'}
                    </button>
                    <button
                      onClick={() => deleteChat(c.id)}
                      className="p-1.5 mr-1 rounded text-[var(--muted)] hover:text-red-500"
                      aria-label="Delete chat"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Settings & memory panel */}
        {settingsOpen && (
          <div className="fixed inset-0 z-30 flex justify-end">
            <div className="absolute inset-0 bg-black/40" onClick={() => { setSettingsOpen(false); persistSettings() }} />
            <div
              className="relative w-80 max-w-[88%] h-full flex flex-col shadow-xl bg-[var(--surface)] text-[var(--text)]"
              style={{ paddingTop: TOP_INSET }}
            >
              <div className="flex items-center justify-between px-4 pb-3 border-b border-[var(--border)]">
                <span className="font-semibold flex items-center gap-1.5"><Settings size={16} /> Settings</span>
                <button
                  onClick={() => { setSettingsOpen(false); persistSettings() }}
                  className="p-1.5 rounded-lg text-[var(--muted)] hover:bg-[var(--surface-2)]"
                  aria-label="Close settings"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <div>
                  <label className="text-xs font-semibold text-[var(--muted)]">About you</label>
                  <textarea
                    value={aboutYou}
                    onChange={(e) => setAboutYou(e.target.value)}
                    onBlur={persistSettings}
                    rows={3}
                    placeholder="e.g. My name is Alex. I'm a teacher who loves hiking."
                    className="w-full mt-1 px-3 py-2 rounded-lg text-sm border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)] placeholder:text-[var(--muted)] resize-none"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-[var(--muted)]">How should I respond?</label>
                  <textarea
                    value={customInstructions}
                    onChange={(e) => setCustomInstructions(e.target.value)}
                    onBlur={persistSettings}
                    rows={3}
                    placeholder="e.g. Keep answers warm and concise. Avoid jargon."
                    className="w-full mt-1 px-3 py-2 rounded-lg text-sm border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)] placeholder:text-[var(--muted)] resize-none"
                  />
                </div>

                <div className="border-t border-[var(--border)] pt-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium flex items-center gap-1.5"><Brain size={15} /> Memory</span>
                    <button
                      onClick={() => { setMemoryEnabled((v) => { const nv = !v; saveSettings({ about_you: aboutYou, custom_instructions: customInstructions, memory_enabled: nv }); return nv }) }}
                      className={`w-11 h-6 rounded-full relative transition-colors ${memoryEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--surface-2)]'}`}
                      aria-label="Toggle memory"
                    >
                      <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${memoryEnabled ? 'left-[1.375rem]' : 'left-0.5'}`} />
                    </button>
                  </div>
                  <p className="text-xs text-[var(--muted)] mt-1">
                    {memoryAvailable
                      ? 'I remember useful facts across chats. Say "remember that…" or add one below.'
                      : 'Memory needs the Supabase migration (supabase-memory-schema.sql) to be run.'}
                  </p>

                  {memoryAvailable && (
                    <>
                      <div className="flex gap-2 mt-3">
                        <input
                          type="text"
                          value={newMemory}
                          onChange={(e) => setNewMemory(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') addManualMemory() }}
                          placeholder="Add a memory…"
                          className="flex-1 min-w-0 px-3 py-1.5 rounded-lg text-sm border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)] placeholder:text-[var(--muted)]"
                        />
                        <button
                          onClick={addManualMemory}
                          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)]"
                        >
                          Add
                        </button>
                      </div>
                      <div className="mt-3 space-y-1.5">
                        {memories.length === 0 ? (
                          <p className="text-xs text-[var(--muted)] italic">No memories yet.</p>
                        ) : memories.map((m) => (
                          <div key={m.id} className="flex items-start gap-2 text-sm bg-[var(--surface-2)] rounded-lg px-3 py-2">
                            <span className="flex-1">{m.text}</span>
                            <button
                              onClick={() => removeMemory(m.id)}
                              className="text-[var(--muted)] hover:text-red-500 shrink-0"
                              aria-label="Delete memory"
                            >
                              <Trash size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <div className="border-t border-[var(--border)] pt-3">
                  <span className="text-sm font-medium flex items-center gap-1.5"><Share2 size={15} /> Shared links</span>
                  <p className="text-xs text-[var(--muted)] mt-1">Read-only snapshots you've shared. Revoke a link to make it stop working.</p>
                  <div className="mt-3 space-y-1.5">
                    {shares === null ? (
                      <p className="text-xs text-[var(--muted)] italic">Loading…</p>
                    ) : shares.length === 0 ? (
                      <p className="text-xs text-[var(--muted)] italic">No shared links yet.</p>
                    ) : shares.map((s) => (
                      <div key={s.id} className="flex items-center gap-2 text-sm bg-[var(--surface-2)] rounded-lg px-3 py-2">
                        <span className="flex-1 min-w-0 truncate" title={s.title}>{s.title || 'Shared chat'}</span>
                        <button
                          onClick={() => copyShareUrl(s.id)}
                          className="text-[var(--muted)] hover:text-[var(--accent)] shrink-0"
                          aria-label="Copy link"
                          title="Copy link"
                        >
                          <Copy size={14} />
                        </button>
                        <button
                          onClick={() => revokeShare(s.id)}
                          className="text-[var(--muted)] hover:text-red-500 shrink-0"
                          aria-label="Revoke link"
                          title="Revoke link"
                        >
                          <Trash size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Sign-in modal — passwordless email magic link or Google OAuth. */}
        {authOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setAuthOpen(false)}>
            <div
              className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-lg font-semibold text-[var(--text)]">Sign in to FreeGPT</h2>
                <button onClick={() => setAuthOpen(false)} className="p-1 rounded-lg text-[var(--muted)] hover:bg-[var(--surface-2)]" aria-label="Close">
                  <X size={18} />
                </button>
              </div>
              <p className="text-sm text-[var(--muted)] mb-4">
                Free, optional — sign in to sync your chats and memory across devices. Without an account everything stays private on this device.
              </p>

              {authSent ? (
                <div className="text-sm text-[var(--text)] rounded-lg bg-[var(--surface-2)] p-3">
                  ✅ Check your email — we sent a sign-in link to <span className="font-medium">{authEmail}</span>. Open it on this device to finish.
                </div>
              ) : (
                <>
                  <button
                    onClick={doGoogle}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] hover:opacity-90 mb-3"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z"/></svg>
                    Continue with Google
                  </button>

                  <div className="flex items-center gap-2 my-3 text-[10px] text-[var(--muted)]">
                    <div className="flex-1 h-px bg-[var(--border)]" /> OR <div className="flex-1 h-px bg-[var(--border)]" />
                  </div>

                  <label className="block text-xs text-[var(--muted)] mb-1">Email address</label>
                  <div className="flex gap-2">
                    <input
                      type="email"
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') sendMagicLink() }}
                      placeholder="you@example.com"
                      className="flex-1 px-3 py-2 rounded-lg border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)] text-sm"
                    />
                    <button
                      onClick={sendMagicLink}
                      className="flex items-center gap-1 px-3 py-2 rounded-lg bg-[var(--accent)] text-[var(--accent-text)] text-sm font-medium hover:opacity-90"
                    >
                      <Mail size={15} /> Send link
                    </button>
                  </div>
                  {authMsg && <p className="text-xs text-red-500 mt-2">{authMsg}</p>}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
