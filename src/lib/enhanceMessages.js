// Post-render enhancement for assistant messages: syntax highlighting (highlight.js)
// and math rendering (KaTeX). Both libraries — and their CSS — are dynamically imported
// on first use, so they add nothing to initial load.

let hljsPromise = null
let katexPromise = null

function getHljs() {
  if (!hljsPromise) {
    hljsPromise = Promise.all([
      import('highlight.js/styles/github-dark.css'),
      import('highlight.js/lib/common'),
    ]).then(([, mod]) => mod.default)
  }
  return hljsPromise
}

function getKatex() {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import('katex/dist/katex.min.css'),
      import('katex/contrib/auto-render'),
    ]).then(([, mod]) => mod.default)
  }
  return katexPromise
}

// Highlight code blocks and render math inside `container`. Idempotent: elements are
// marked once processed so re-running (on new messages) skips finished ones.
export async function enhanceMessages(container) {
  if (!container) return

  const codeBlocks = container.querySelectorAll('pre code:not([data-hl])')
  if (codeBlocks.length) {
    try {
      const hljs = await getHljs()
      codeBlocks.forEach((el) => {
        try { hljs.highlightElement(el) } catch { /* unknown lang */ }
        el.setAttribute('data-hl', '1')
      })
    } catch { /* import failed — leave code unstyled */ }
  }

  const mathTargets = container.querySelectorAll('.md-body:not([data-katex])')
  if (mathTargets.length) {
    try {
      const renderMathInElement = await getKatex()
      mathTargets.forEach((el) => {
        try {
          renderMathInElement(el, {
            delimiters: [
              { left: '$$', right: '$$', display: true },
              { left: '\\[', right: '\\]', display: true },
              { left: '\\(', right: '\\)', display: false },
              { left: '$', right: '$', display: false },
            ],
            throwOnError: false,
          })
        } catch { /* malformed math */ }
        el.setAttribute('data-katex', '1')
      })
    } catch { /* import failed — leave math as text */ }
  }
}
