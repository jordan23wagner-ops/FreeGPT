// Phase 3 — "Run" buttons on Python code blocks.
//
// Assistant bubbles are rendered as raw HTML (renderMarkdown → dangerouslySetInnerHTML), so
// like enhanceMessages.js this works by post-render DOM enhancement rather than React: after
// each reply settles we scan for Python <pre> blocks and bolt a Run button + output panel onto
// each. The interpreter itself (Pyodide) is lazy-loaded only on the first click — see pyodide.js.
//
// Re-running is cheap & idempotent: React recreates the bubble's innerHTML on every state
// change (wiping injected nodes), so we simply re-attach. Any previous run output is ephemeral.

const PY_LANGS = ['language-python', 'language-py']

function isPython(codeEl) {
  return PY_LANGS.some((c) => codeEl.classList.contains(c))
}

function makeButton(label) {
  const b = document.createElement('button')
  b.textContent = label
  b.style.cssText =
    'display:inline-flex;align-items:center;gap:5px;font-size:11px;font-family:inherit;' +
    'padding:3px 10px;border-radius:6px;border:none;cursor:pointer;' +
    'background:var(--accent,#3b82f6);color:var(--accent-text,#fff)'
  return b
}

function renderResult(panel, res) {
  panel.innerHTML = ''
  panel.style.display = 'block'

  const addPre = (text, color) => {
    if (!text) return
    const pre = document.createElement('pre')
    pre.textContent = text
    pre.style.cssText =
      'margin:6px 0 0;padding:8px 10px;border-radius:6px;background:#0d1117;' +
      `color:${color};font-family:ui-monospace,Menlo,monospace;font-size:0.8em;` +
      'white-space:pre-wrap;word-break:break-word;overflow-x:auto'
    panel.appendChild(pre)
  }

  addPre(res.stdout, '#c9d1d9')
  addPre(res.stderr, '#e3b341')
  addPre(res.error, '#ff7b72')

  for (const b64 of res.images || []) {
    const img = document.createElement('img')
    img.src = `data:image/png;base64,${b64}`
    img.alt = 'plot'
    img.style.cssText = 'display:block;margin:6px 0 0;max-width:100%;border-radius:6px'
    panel.appendChild(img)
  }

  if (!res.stdout && !res.stderr && !res.error && !(res.images || []).length) {
    addPre('(no output)', '#8b949e')
  }
}

// Scan `container` for Python code blocks and attach a Run control to each new one.
export function attachRunButtons(container) {
  if (!container || typeof document === 'undefined') return
  const blocks = container.querySelectorAll('pre:not([data-runnable]) > code')

  blocks.forEach((codeEl) => {
    if (!isPython(codeEl)) return
    const pre = codeEl.parentElement
    pre.setAttribute('data-runnable', '1')

    const bar = document.createElement('div')
    bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin:6px 0 2px'

    const runBtn = makeButton('▶ Run')
    const status = document.createElement('span')
    status.style.cssText = 'font-size:11px;color:var(--muted,#8b949e)'

    const panel = document.createElement('div')
    panel.style.display = 'none'

    runBtn.addEventListener('click', async () => {
      const code = codeEl.textContent || ''
      if (!code.trim()) return
      runBtn.disabled = true
      runBtn.style.opacity = '0.6'
      runBtn.style.cursor = 'wait'
      status.textContent = window.loadPyodide ? 'Running…' : 'Loading Python… (first run ~5s)'
      try {
        const { runPython } = await import('./pyodide.js')
        const res = await runPython(code)
        renderResult(panel, res)
        status.textContent = ''
      } catch (e) {
        status.textContent = 'Failed: ' + (e.message || 'unknown error')
      } finally {
        runBtn.disabled = false
        runBtn.style.opacity = '1'
        runBtn.style.cursor = 'pointer'
        runBtn.textContent = '▶ Run again'
      }
    })

    bar.appendChild(runBtn)
    bar.appendChild(status)
    // Insert the control bar + output panel right after the code block.
    pre.insertAdjacentElement('afterend', panel)
    pre.insertAdjacentElement('afterend', bar)
  })
}
