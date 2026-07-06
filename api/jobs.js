// Chatwillow jobs proxy — Adzuna Job Search API.
// Keeps the Adzuna credentials server-side (ADZUNA_APP_ID / ADZUNA_APP_KEY env vars) so no key
// ships in the Job-Assistant extension — the extension calls THIS endpoint instead of Adzuna.
//
// POST { action:'search', what, whatExclude, where, salaryMin, salaryMax, category, remote,
//        fullTime, sortBy, page, resultsPerPage, country }
//   -> { results:[{ id,title,company,location,salaryMin,salaryMax,salaryPredicted,url,category,
//                   categoryTag,contractTime,description,created }], count }
// POST { action:'categories', country } -> { categories:[{ tag,label }] }
//
// Remote note: Adzuna has no clean remote flag, so remote:true just appends "remote" to `what`.
// That's an approximation (documented for the caller), not a guaranteed filter.

const ADZUNA_BASE = 'https://api.adzuna.com/v1/api/jobs';

export default async function handler(req, res) {
  // CORS — same reflect-origin approach as chat.js so the chrome-extension:// origin passes preflight.
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const APP_ID = process.env.ADZUNA_APP_ID;
  const APP_KEY = process.env.ADZUNA_APP_KEY;
  if (!APP_ID || !APP_KEY) {
    // `have` reports only presence (booleans, never the values) to pinpoint a wrong project,
    // wrong scope, or a name typo without leaking secrets.
    return res.status(500).json({
      error: 'Job search is not configured yet (set ADZUNA_APP_ID and ADZUNA_APP_KEY in the backend environment).',
      have: { ADZUNA_APP_ID: !!APP_ID, ADZUNA_APP_KEY: !!APP_KEY },
      // Diagnostic: env-var NAMES containing "adzuna" (names only — never values). Empty => the vars
      // aren't on this project/scope; different names => a naming mismatch to fix.
      adzunaVarsSeen: Object.keys(process.env).filter((k) => /adzuna/i.test(k))
    });
  }

  const body = req.body || {};
  const country = (String(body.country || 'us').toLowerCase().replace(/[^a-z]/g, '')) || 'us';
  const auth = `app_id=${encodeURIComponent(APP_ID)}&app_key=${encodeURIComponent(APP_KEY)}`;

  try {
    if (body.action === 'categories') {
      const r = await fetch(`${ADZUNA_BASE}/${country}/categories?${auth}`, { headers: { 'Content-Type': 'application/json' } });
      if (!r.ok) return res.status(502).json({ error: 'Adzuna categories error ' + r.status });
      const d = await r.json();
      const categories = (d.results || [])
        .filter((c) => c && c.tag && c.label)
        .map((c) => ({ tag: c.tag, label: c.label }));
      return res.status(200).json({ categories });
    }

    // Default action: search.
    const page = Math.max(1, parseInt(body.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(body.resultsPerPage, 10) || 20));
    const params = new URLSearchParams();
    params.set('results_per_page', String(perPage));

    let what = String(body.what || '').trim();
    if (body.remote) what = (what + ' remote').trim(); // Adzuna has no remote flag — keyword hint only
    if (what) params.set('what', what);
    if (body.whatExclude) params.set('what_exclude', String(body.whatExclude));
    if (body.where) params.set('where', String(body.where));
    const sMin = parseInt(body.salaryMin, 10);
    if (sMin > 0) params.set('salary_min', String(sMin));
    const sMax = parseInt(body.salaryMax, 10);
    if (sMax > 0) params.set('salary_max', String(sMax));
    if (body.category) params.set('category', String(body.category));
    if (body.fullTime) params.set('full_time', '1');
    params.set('sort_by', body.sortBy === 'salary' ? 'salary' : (body.sortBy === 'date' ? 'date' : 'relevance'));
    params.set('content-type', 'application/json');

    const r = await fetch(`${ADZUNA_BASE}/${country}/search/${page}?${auth}&${params.toString()}`, { headers: { 'Content-Type': 'application/json' } });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return res.status(502).json({ error: 'Adzuna search error ' + r.status, detail: t.slice(0, 300) });
    }
    const d = await r.json();
    const results = (d.results || []).map((j) => ({
      id: j.id,
      title: j.title,
      company: (j.company && j.company.display_name) || '',
      location: (j.location && j.location.display_name) || '',
      salaryMin: j.salary_min || null,
      salaryMax: j.salary_max || null,
      salaryPredicted: j.salary_is_predicted === '1' || j.salary_is_predicted === true,
      url: j.redirect_url || '',
      category: (j.category && j.category.label) || '',
      categoryTag: (j.category && j.category.tag) || '',
      contractTime: j.contract_time || '',
      description: String(j.description || '').replace(/\s+/g, ' ').trim(),
      created: j.created || ''
    }));
    return res.status(200).json({ results, count: d.count || results.length });
  } catch (err) {
    console.error('jobs proxy failed:', err && err.message);
    return res.status(502).json({ error: 'Job search failed: ' + ((err && err.message) || 'unknown') });
  }
}
