// Phase 3 — in-browser Python code interpreter via Pyodide (WASM).
//
// Pyodide is loaded lazily from the public jsDelivr CDN the first time the user clicks
// "Run" — it adds NOTHING to startup and needs no key, no server, no build dependency
// (keeping the $0/month, serverless design rule intact). numpy / pandas / matplotlib ship
// with the distribution and are auto-loaded on demand from the user's imports.

const PYODIDE_VERSION = '0.26.4'
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`

let pyodidePromise = null

// Inject the loader <script> once, resolving when window.loadPyodide is available.
function loadScript() {
  return new Promise((resolve, reject) => {
    if (window.loadPyodide) return resolve()
    const existing = document.querySelector('script[data-pyodide]')
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Failed to load Pyodide')))
      return
    }
    const s = document.createElement('script')
    s.src = `${PYODIDE_BASE}pyodide.js`
    s.async = true
    s.dataset.pyodide = '1'
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Failed to load Pyodide (offline?)'))
    document.head.appendChild(s)
  })
}

// Boot the interpreter once and reuse it for every run (a fresh boot is ~5s; reuse is instant).
// Returns the live pyodide instance.
export function getPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      await loadScript()
      const py = await window.loadPyodide({ indexURL: PYODIDE_BASE })
      // Force a headless backend so matplotlib.savefig() works without a canvas element.
      await py.runPythonAsync(`import os; os.environ['MPLBACKEND'] = 'AGG'`)
      return py
    })().catch((e) => {
      pyodidePromise = null // allow a retry on transient CDN failure
      throw e
    })
  }
  return pyodidePromise
}

// Python snippet run AFTER the user's code to harvest any open matplotlib figures as PNGs.
const CAPTURE_FIGURES = `
import json as _json
_imgs = []
try:
    import sys as _sys
    if 'matplotlib' in _sys.modules:
        import matplotlib.pyplot as _plt, io as _io, base64 as _b64
        for _n in _plt.get_fignums():
            _buf = _io.BytesIO()
            _plt.figure(_n).savefig(_buf, format='png', bbox_inches='tight', dpi=110)
            _imgs.append(_b64.b64encode(_buf.getvalue()).decode())
        _plt.close('all')
except Exception:
    pass
_json.dumps(_imgs)
`

// Run `code`, returning { stdout, stderr, error, images } where images is an array of
// base64-encoded PNGs (data is bare base64, no data: prefix). Never throws.
export async function runPython(code) {
  const out = []
  const err = []
  let error = null
  let images = []

  let py
  try {
    py = await getPyodide()
  } catch (e) {
    return { stdout: '', stderr: '', error: e.message || 'Could not start Python', images: [] }
  }

  // `batched` fires once per line with the newline stripped, so we rejoin with '\n'.
  py.setStdout({ batched: (s) => out.push(s) })
  py.setStderr({ batched: (s) => err.push(s) })

  try {
    // Auto-install any packages the snippet imports (numpy, pandas, matplotlib, …).
    await py.loadPackagesFromImports(code)
    await py.runPythonAsync(code)
  } catch (e) {
    error = String(e && e.message ? e.message : e)
  }

  // Harvest figures even if the body raised, in case it drew before failing.
  try {
    const json = await py.runPythonAsync(CAPTURE_FIGURES)
    images = JSON.parse(json)
  } catch { /* no figures / capture failed */ }

  // Restore default streams so a later boot-time print doesn't push into a stale buffer.
  try { py.setStdout({}); py.setStderr({}) } catch { /* ignore */ }

  return {
    stdout: out.join('\n'),
    stderr: err.join('\n'),
    error,
    images,
  }
}
