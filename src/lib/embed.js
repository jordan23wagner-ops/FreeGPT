// In-browser embeddings via transformers.js, using the SAME model as the original
// mcp-memory-server (all-MiniLM-L6-v2, 384-dim). No API key, fully local and free.
// The model (~25MB) downloads once on first use and is cached by the browser.

let extractorPromise = null

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers')
      // Use the hosted model + browser cache; don't look for local files.
      env.allowLocalModels = false
      return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
    })()
  }
  return extractorPromise
}

// Returns a 384-dim, mean-pooled, L2-normalized embedding (standard for this model),
// so pgvector's cosine distance (<=>) matches the server's behavior.
export async function embed(text) {
  const extractor = await getExtractor()
  const output = await extractor(String(text || '').slice(0, 4000), { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

// Kick off the model download early (e.g., when settings open) so the first real
// embedding isn't slow. Best-effort; ignores failures.
export function warmEmbedder() {
  getExtractor().catch(() => {})
}
