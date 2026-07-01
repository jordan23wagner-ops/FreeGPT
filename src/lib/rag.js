// Phase 2b — Document RAG (no setup, free, in-browser). Large uploaded documents used
// to be truncated at a hard char cap; instead we now chunk + embed the full text once,
// then on each turn retrieve only the chunks most relevant to the question and inject
// those. Embeddings reuse embed.js (transformers.js all-MiniLM-L6-v2, 384-dim) — no key,
// no server.
//
// The chunker is a faithful port of the user's `rag-post-processor` (chunk_size=1000,
// overlap=100, sentence-aware) plus its clean_text. See the project handoff.

import { embed } from './embed'

// Docs at or below this many characters keep the simple full-text path — small enough to
// fit comfortably in context, and cheaper than embedding.
export const RAG_THRESHOLD = 6000

const CHUNK_SIZE = 1000
const OVERLAP = 100

// Faithful port of rag-post-processor's clean_text: strip HTML tags + entities + URLs,
// then collapse whitespace.
export function cleanText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-zA-Z]+;/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Faithful port of rag-post-processor's chunker. Fixed window with overlap, but when not
// at the end of the text, break at the last ". " occurring after 60% of the window so
// chunks end on a sentence boundary. Advances start = end - overlap.
export function chunkText(text, chunkSize = CHUNK_SIZE, overlap = OVERLAP) {
  const clean = cleanText(text)
  if (clean.length <= chunkSize) return clean ? [clean] : []
  const chunks = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length)
    if (end < clean.length) {
      const dot = clean.slice(start, end).lastIndexOf('. ')
      if (dot > chunkSize * 0.6) end = start + dot + 1 // include the period
    }
    const piece = clean.slice(start, end).trim()
    if (piece) chunks.push(piece)
    if (end >= clean.length) break
    start = end - overlap
  }
  return chunks
}

// Cosine similarity for L2-normalized embeddings == dot product.
function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

// Per-session cache of index promises, keyed by a caller-supplied id, so each document is
// embedded only once. A failed build is evicted so it can be retried.
const indexCache = new Map()

// A stable id for a parsed document (name + length is plenty for one session).
export function docId(name, text) {
  return `${name || 'doc'}:${(text || '').length}`
}

// Build (or reuse) the embedded chunk index for a document. Resolves to
// { chunks: string[], embeddings: number[][] }. Embeds sequentially because the wasm
// model is single-threaded — parallel calls just contend.
export function buildIndex(id, text) {
  if (!indexCache.has(id)) {
    const p = (async () => {
      const chunks = chunkText(text)
      const embeddings = []
      for (const c of chunks) embeddings.push(await embed(c))
      return { chunks, embeddings }
    })()
    p.catch(() => indexCache.delete(id)) // allow a later retry on failure
    indexCache.set(id, p)
  }
  return indexCache.get(id)
}

// Retrieve the topK chunk texts most relevant to `query` for a document.
export async function retrieveChunks(id, text, query, topK = 4) {
  const index = await buildIndex(id, text)
  if (!index.chunks.length) return []
  const q = await embed(query)
  const scored = index.embeddings.map((e, i) => ({ i, score: dot(q, e) }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK).map((s) => index.chunks[s.i])
}
