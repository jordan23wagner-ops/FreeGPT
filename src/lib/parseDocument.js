// Client-side document text extraction. Heavy parsers are dynamically imported so they
// only download when the user actually uploads that file type — keeping startup fast.
//
// Supported: PDF (.pdf), Word (.docx), CSV (.csv), plain text / markdown (.txt/.md and
// any text/* file). Output is plain text, capped so it never blows the model's context.

// Large docs are no longer dumped wholesale into context — Phase 2b chunks + embeds them
// and retrieves only relevant pieces (see lib/rag.js). So this cap is just a sane ceiling
// to keep browser memory bounded; the model never sees this many chars at once.
export const MAX_CHARS = 100000

const EXT = (name) => (name.split('.').pop() || '').toLowerCase()

export function isSupportedDocument(file) {
  if (!file) return false
  const ext = EXT(file.name)
  if (['pdf', 'docx', 'csv', 'txt', 'md', 'markdown', 'log', 'json'].includes(ext)) return true
  return (file.type || '').startsWith('text/')
}

// Returns { name, chars, truncated, text } or throws with a friendly message.
export async function parseDocument(file) {
  const ext = EXT(file.name)
  let text = ''

  if (ext === 'pdf') {
    text = await parsePdf(file)
  } else if (ext === 'docx') {
    text = await parseDocx(file)
  } else if (ext === 'csv') {
    text = await parseCsv(file)
  } else if (['txt', 'md', 'markdown', 'log', 'json'].includes(ext) || (file.type || '').startsWith('text/')) {
    text = await file.text()
  } else if (ext === 'doc') {
    throw new Error('Old .doc files aren’t supported — save as .docx or PDF.')
  } else {
    throw new Error('Unsupported file type. Try PDF, Word (.docx), CSV, or a text file.')
  }

  text = (text || '').replace(/ /g, ' ').trim() // normalize non-breaking spaces
  if (!text) throw new Error('No readable text found (a scanned PDF? Try uploading it as a photo instead).')

  const truncated = text.length > MAX_CHARS
  if (truncated) text = text.slice(0, MAX_CHARS)
  return { name: file.name, chars: text.length, truncated, text }
}

async function parsePdf(file) {
  const pdfjs = await import('pdfjs-dist')
  // Vite resolves the worker file to a URL we can hand to pdf.js.
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

  const buf = await file.arrayBuffer()
  const pdf = await pdfjs.getDocument({ data: buf }).promise
  const parts = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    parts.push(content.items.map((it) => it.str).join(' '))
    if (parts.join('\n').length > MAX_CHARS) break // stop early once we have enough
  }
  return parts.join('\n\n')
}

async function parseDocx(file) {
  const mammoth = await import('mammoth')
  const buf = await file.arrayBuffer()
  const result = await mammoth.extractRawText({ arrayBuffer: buf })
  return result.value
}

async function parseCsv(file) {
  const Papa = (await import('papaparse')).default
  const raw = await file.text()
  const parsed = Papa.parse(raw.trim(), { skipEmptyLines: true })
  // Render as delimited rows so the model reads it as a table.
  return parsed.data.map((row) => (Array.isArray(row) ? row.join(' | ') : String(row))).join('\n')
}
