# Chatwillow

An AI chat assistant PWA — chat, live web search, image generation, voice, documents, and a Python code interpreter. Mobile-first, serverless, free to use with an optional Pro tier for higher limits.

**Live:** https://chatwillow.com

## What It Does

- **AI chat** with streaming replies, four models, and an "Auto" smart-routing mode.
- **Live web search** with source citations, smart-routed automatically when a question needs current info.
- **Image generation** ("draw me…") with automatic provider fallback.
- **Vision** — upload photos (up to 4) and ask about them, or re-imagine them.
- **Hands-free voice mode** — speak to it and hear replies back.
- **Memory & custom instructions** that carry context across chats (signed-in users).
- **Document chat + export** — upload docs, chat over them (RAG), export replies to Word/PDF.
- **Python code interpreter** — run Python code blocks in-browser via Pyodide.
- **Shareable read-only links** to a snapshot of any conversation.
- **Accounts (optional)** — Google or email sign-in to sync across devices; fully usable signed-out (localStorage only).

## Free vs Pro

The app is free to use. **Pro ($5/mo, via Stripe)** raises daily usage limits — it does **not** gate features; image generation, all models, web search, voice, and the code interpreter are available on the free tier. See [Usage & Quota Protection](#usage--quota-protection).

## Stack

- **Frontend:** React 18 + Vite + Tailwind CSS, installable PWA (service worker).
- **Backend:** Vercel serverless functions (`/api/*`). No dedicated servers.
- **Auth + data:** Supabase (Postgres + pgvector for memory, Row Level Security scoped per user).
- **Billing:** Stripe Checkout + Customer Portal + webhook.
- **Zero fixed monthly cost** aside from the AI provider usage the free keys draw on.

## Chat & Models

Selectable in the header:

| Model | Notes |
|---|---|
| **Auto — smart routing** | Picks a model per message |
| **MiniMax M3** | Vision |
| **Gemma 4** | Vision + images |
| **GPT-OSS 120B** | Smartest (text) |

**Provider fallback.** The `GPT-OSS 120B` route tries **Ollama Cloud → Cerebras → Groq → NVIDIA NIM**. Cerebras and Groq host the same `gpt-oss-120b` model on separate free-tier quota pools, so falling back to them costs no answer quality. The `MiniMax M3` / `Gemma 4` routes are Ollama → NIM only (no free Cerebras/Groq equivalent).

## Image Generation

Tool-calling: the chat model calls a `generate_image` tool when appropriate. Providers fall back automatically — **NVIDIA NIM FLUX.1-dev → HuggingFace FLUX.1-schnell → Pollinations.ai** (free, no key, no aggressive content filter) — so generation keeps working even when NIM filters a benign prompt or runs out of credits. Attach a photo and ask to change it for a photo-informed re-imagining (an AI re-imagining, not a pixel-level edit).

## Web Search

Automatically smart-routed (no manual toggle): when a question needs current information, the backend runs a Tavily search, grounds the answer, and shows source citations. Without `TAVILY_KEY` set, search cleanly no-ops.

## Voice

Hands-free voice mode: speech-to-text input and text-to-speech replies, using the browser's built-in Web Speech APIs.

## Memory & Documents

- **Semantic memory + custom instructions** (signed-in users) — stored in Supabase with pgvector embeddings, retrieved per query.
- **Document RAG** — large uploads are chunked and embedded in-browser, with per-query chunk retrieval.
- **Export** — save replies to Word or PDF.

## Code Interpreter

Python code blocks get a **Run** button, executed in-browser with Pyodide (no server round-trip).

## Accounts & Sync

- Sign in with **Google** or an **email magic-link** (Supabase Auth).
- Signed in → conversations, memories, and settings sync across devices via Supabase (every row scoped to your `auth.uid()` under Row Level Security).
- Signed out → the app works fully, private to your browser via localStorage.

## Usage & Quota Protection

The chat backend runs on shared free AI keys across all visitors, so requests are metered by estimated **generation-time** (GPU-seconds), enforced server-side before any provider call:

| Tier | Default daily cap |
|---|---|
| Anonymous (hashed IP) | 10 min (`ANON_DAILY_SECONDS_CAP=600`) |
| Signed-in free | 30 min (`FREE_DAILY_SECONDS_CAP=1800`) |
| Pro | 2 hr (`PRO_DAILY_SECONDS_CAP=7200`) |
| **Whole app (global ceiling)** | 6 hr (`GLOBAL_DAILY_SECONDS_CAP=21600`) |

Caps are tunable via env vars (no redeploy needed) and are rough starting points — watch the provider dashboards and adjust. The gate **fails open**: if the usage tables/service-role key are absent, it never blocks chat.

## Architecture

- `api/chat.js` — streaming chat (provider fallback), image tool, web search, and the usage gate.
- `api/stripe-checkout.js` / `api/stripe-portal.js` / `api/stripe-webhook.js` — Pro subscription lifecycle. The webhook verifies Stripe signatures against the raw body before trusting any event and writes to the `subscriptions` table with the service-role key.
- `api/memory-extract.js` / `api/suggest.js` — memory extraction and suggested prompts.
- `src/lib/*` — auth, billing, sync, memory, RAG, export, sharing, themes, markdown/artifacts rendering, Pyodide runner, usage helpers.
- `supabase-setup.sql` — full schema with RLS on every table (per-user scoping), plus service-role-only usage-tracking tables.

## Environment Variables (Vercel)

**AI providers**

| Variable | Required | Purpose |
|---|---|---|
| `OLLAMA_CLOUD_KEY` | Yes | Primary (free) chat |
| `NVIDIA_NIM_KEY` | Yes | Chat fallback + image generation (FLUX.1-dev) |
| `CEREBRAS_KEY` | Recommended | `gpt-oss-120b` fallback (separate free quota) |
| `GROQ_KEY` | Recommended | `gpt-oss-120b` fallback (separate free quota) |
| `HUGGINGFACE_KEY` | Recommended | Image fallback (fires when NIM filters/errors) |
| `TAVILY_KEY` | Optional | Web search (free tier at tavily.com); search no-ops without it |

**Auth & data**

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-side writes (subscriptions, usage tracking); bypasses RLS server-side only |

The Supabase project URL + **publishable anon key** are embedded in the frontend bundle — standard Supabase practice (like a Stripe publishable key); security comes from RLS + Auth, not from hiding this key.

**Billing (Pro tier)**

| Variable | Required | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | For Pro | Stripe API (use a live key in production) |
| `STRIPE_PRICE_ID` | For Pro | The $5/mo recurring price ID |
| `STRIPE_WEBHOOK_SECRET` | For Pro | Verifies incoming Stripe webhook signatures |

**Quota caps (optional — all have sane defaults)**

`ANON_DAILY_SECONDS_CAP`, `FREE_DAILY_SECONDS_CAP`, `PRO_DAILY_SECONDS_CAP`, `GLOBAL_DAILY_SECONDS_CAP` — see [Usage & Quota Protection](#usage--quota-protection).

## Deploy

1. Create a Supabase project and run `supabase-setup.sql` in its SQL Editor.
2. Paste the project URL + anon key into `src/lib/supabase.js`.
3. Set the environment variables above in Vercel (production).
4. For Pro: create a live Stripe product/price + webhook endpoint (`/api/stripe-webhook`), and set the three `STRIPE_*` vars.
5. Push to `main` — Vercel auto-deploys. Env changes only apply to new deployments.

## Local Development

```bash
npm install
npm run dev     # Vite dev server
npm run build   # production build
```

Serverless functions under `/api` require the environment variables above (use `vercel dev` to run them locally).

## License

Personal project. Not affiliated with OpenAI, Anthropic, or any AI provider whose models it calls.
