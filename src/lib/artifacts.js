// Phase 4 — Artifacts / Canvas.
//
// When a reply contains a self-contained HTML/SVG document, render it live in a SANDBOXED
// <iframe> with a Code ⇄ Preview toggle. Same post-render DOM-enhancement approach as
// codeRunner.js (bubbles are dangerouslySetInnerHTML, so we scan + attach after each reply
// and re-attach on re-render). Nothing here touches the network or any key — pure browser.
//
// Security: the iframe uses `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so artifact
// JS runs in a unique opaque origin — it cannot read this app's DOM, storage, cookies, or
// Supabase session. That's the whole point of previewing model-generated markup safely.

const HTML_LANGS = ['language-html', 'language-svg', 'language-xml']

// Treat a block as a previewable artifact if it's tagged html/svg/xml, or its content clearly
// looks like a standalone document. Kept deliberately strict to avoid buttoning every snippet.
function isArtifact(codeEl) {
  const txt = (codeEl.textContent || '').trim()
  if (!txt) return false
  const looksDoc = /<!doctype html|<html[\s>]|^<svg[\s>]/i.test(txt)
  const tagged = HTML_LANGS.some((c) => codeEl.classList.contains(c)) && /<[a-z!]/i.test(txt)
  return looksDoc || tagged
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

export function attachArtifacts(container) {
  if (!container || typeof document === 'undefined') return
  const blocks = container.querySelectorAll('pre:not([data-artifact]) > code')

  blocks.forEach((codeEl) => {
    if (!isArtifact(codeEl)) return
    const pre = codeEl.parentElement
    pre.setAttribute('data-artifact', '1')

    const bar = document.createElement('div')
    bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin:6px 0 2px'
    const toggleBtn = makeButton('▶ Preview')

    const frameWrap = document.createElement('div')
    frameWrap.style.display = 'none'
    frameWrap.style.cssText =
      'display:none;margin:6px 0 0;border:1px solid var(--border,rgba(128,128,128,.3));' +
      'border-radius:8px;overflow:hidden;background:#fff'

    let iframe = null
    let shown = false

    toggleBtn.addEventListener('click', () => {
      shown = !shown
      if (shown) {
        // The bubble is shrink-to-fit, so a width:100% iframe would collapse to 0 once the
        // code block (its only intrinsic-width content) is hidden. Pin the preview to the
        // measured width of the rendered markdown body before hiding the code.
        const body = codeEl.closest('.md-body') || pre.parentElement
        const w = body && body.clientWidth ? body.clientWidth : 0
        frameWrap.style.width = w ? w + 'px' : '100%'
        if (!iframe) {
          iframe = document.createElement('iframe')
          // No allow-same-origin: artifact runs in an isolated origin (can't touch this app).
          iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms allow-modals')
          iframe.setAttribute('referrerpolicy', 'no-referrer')
          iframe.style.cssText = 'width:100%;height:420px;border:0;display:block;background:#fff'
          iframe.srcdoc = codeEl.textContent || ''
          frameWrap.appendChild(iframe)
        }
        frameWrap.style.display = 'block'
        pre.style.display = 'none'
        toggleBtn.textContent = '◀ Code'
      } else {
        frameWrap.style.display = 'none'
        pre.style.display = ''
        toggleBtn.textContent = '▶ Preview'
      }
    })

    bar.appendChild(toggleBtn)
    pre.insertAdjacentElement('afterend', frameWrap)
    pre.insertAdjacentElement('afterend', bar)
  })
}
