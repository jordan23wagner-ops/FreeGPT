// Markdown-to-HTML for assistant replies in chat bubbles.
// Handles: fenced code blocks, tables, **bold**, *italic*, `code`, [links](url),
// ## headings, - bullet lists, numbered lists, --- rules, paragraphs.
// Output is escaped first, then only known-safe tags are injected.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function inline(text) {
  let s = esc(text)
  // Links first so bold/italic don't mangle URLs: [label](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:var(--accent,#3b82f6);text-decoration:underline">$1</a>')
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>')
  s = s.replace(/`([^`]+?)`/g, '<code style="background:rgba(128,128,128,.18);padding:1px 4px;border-radius:3px;font-size:0.85em">$1</code>')
  return s
}

// A markdown table separator row, e.g. |---|:--:| or --- | ---
function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)
}

function splitRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

function renderTable(header, rows) {
  const th = header.map((c) => `<th style="border:1px solid var(--border,#d1d5db);padding:5px 9px;text-align:left;font-weight:600;background:rgba(128,128,128,.1)">${inline(c)}</th>`).join('')
  const body = rows
    .map((r) => '<tr>' + header.map((_, i) => `<td style="border:1px solid var(--border,#d1d5db);padding:5px 9px;vertical-align:top">${inline(r[i] || '')}</td>`).join('') + '</tr>')
    .join('')
  return (
    `<div style="overflow-x:auto;margin:8px 0;-webkit-overflow-scrolling:touch">` +
    `<table style="border-collapse:collapse;font-size:0.85em;min-width:100%">` +
    `<thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`
  )
}

export default function renderMarkdown(text) {
  const lines = String(text || '').split('\n')
  const out = []
  let i = 0
  let inList = false
  let listTag = null
  const closeList = () => { if (inList) { out.push(`</${listTag}>`); inList = false } }

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block ```lang ... ```
    if (/^\s*```/.test(line)) {
      closeList()
      const lang = line.trim().replace(/^`+/, '').trim().toLowerCase()
      const langClass = /^[a-z0-9+#-]+$/.test(lang) ? ` language-${lang}` : ''
      const buf = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++ // skip closing fence
      // Dark code theme (like most IDEs/ChatGPT); highlight.js colors the tokens later.
      out.push(
        `<pre style="overflow-x:auto;background:#0d1117;padding:10px 12px;border-radius:8px;margin:8px 0;-webkit-overflow-scrolling:touch">` +
        `<code class="hljs${langClass}" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.82em;white-space:pre;color:#c9d1d9;background:transparent">${esc(buf.join('\n'))}</code></pre>`
      )
      continue
    }

    // Table: a row containing | followed by a separator row
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      closeList()
      const header = splitRow(line)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++ }
      out.push(renderTable(header, rows))
      continue
    }

    // Headings
    const h3 = line.match(/^###\s+(.+)/)
    if (h3) { closeList(); out.push(`<div style="font-weight:700;font-size:0.95em;margin:10px 0 2px">${inline(h3[1])}</div>`); i++; continue }
    const h2 = line.match(/^##\s+(.+)/)
    if (h2) { closeList(); out.push(`<div style="font-weight:700;font-size:1.05em;margin:12px 0 3px">${inline(h2[1])}</div>`); i++; continue }
    const h1 = line.match(/^#\s+(.+)/)
    if (h1) { closeList(); out.push(`<div style="font-weight:700;font-size:1.15em;margin:14px 0 4px">${inline(h1[1])}</div>`); i++; continue }

    // Unordered list
    const ul = line.match(/^\s*[-*]\s+(.+)/)
    if (ul) {
      if (!inList || listTag !== 'ul') { closeList(); out.push('<ul style="margin:2px 0 2px 18px;padding:0">'); inList = true; listTag = 'ul' }
      out.push(`<li style="margin:1px 0">${inline(ul[1])}</li>`); i++; continue
    }

    // Ordered list
    const ol = line.match(/^\s*\d+[.)]\s+(.+)/)
    if (ol) {
      if (!inList || listTag !== 'ol') { closeList(); out.push('<ol style="margin:2px 0 2px 18px;padding:0">'); inList = true; listTag = 'ol' }
      out.push(`<li style="margin:1px 0">${inline(ol[1])}</li>`); i++; continue
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { closeList(); out.push('<hr style="border:none;border-top:1px solid var(--border,rgba(128,128,128,.3));margin:8px 0"/>'); i++; continue }

    // Blank line
    if (!line.trim()) { closeList(); out.push('<div style="height:6px"></div>'); i++; continue }

    // Normal text
    closeList()
    out.push(`<div>${inline(line)}</div>`)
    i++
  }
  closeList()
  return out.join('')
}
