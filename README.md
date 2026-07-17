# vbfences.com — source of truth

Live site: Cloudflare Worker `vbfences` (account Justifiedtrust) serving static
assets from `public/` plus the lead/track API. Reconstructed from the deployed
worker + live pages on 2026-07-17 after the old GitHub Pages shell went stale.

**Do NOT deploy from `~/Downloads/VBFENCES/worker.js` — that file is the May
2026 KV-era worker and will regress production.** This repo is the source now.

## Layout

```
src/worker.js     — the Worker: static assets, /api/lead, /api/track, 301 map,
                    security headers, Turnstile verify (dormant until secret set)
public/           — the 16 pages, css, js, assets, robots.txt, sitemap.xml
wrangler.jsonc    — deploy config (KV binding, route, assets dir)
```

## Deploy

```
npx wrangler deploy
```

Secrets persist on the Worker across deploys. Currently set: `RESEND_API_KEY`,
`GOOGLE_API_KEY`. Vars: `SITE_URL`.

## What changed on 2026-07-17

1. **All 428 internal links rewritten `.html` → extensionless** to match the
   canonical/sitemap URLs (kills the sitewide cached 307 hops).
2. **Worker REDIRECTS map expanded**: every legacy `.html` URL now 301s to its
   canonical extensionless URL; suffolk/portsmouth aliases fixed to land
   directly on `/locations/service-areas` (was double-hopping via a `.html`
   target).
3. **Turnstile wired, dormant-safe** (spam was coming through the form):
   - `public/js/site.js` renders the widget only when the real sitekey is
     pasted in (placeholder `REPLACE_WITH_TURNSTILE_SITEKEY` = nothing renders,
     current behavior unchanged).
   - `src/worker.js` verifies the token only when `TURNSTILE_SECRET` is set.
   - **A failed/missing check never drops a lead** — it is stored in KV with
     `verified:false` and emailed with a `[SUSPECT]` subject prefix. Filter
     your inbox on `[SUSPECT]`, never lose a real customer.
   - CSP already updated for `challenges.cloudflare.com`.

## Activating Turnstile (one-time, ~2 minutes)

1. dash.cloudflare.com → Turnstile → Add widget → name `vbfences-quote-form`,
   domains `vbfences.com`, `www.vbfences.com`, mode **Managed**.
2. Paste the **sitekey** into `public/js/site.js` (replace
   `REPLACE_WITH_TURNSTILE_SITEKEY`).
3. `npx wrangler secret put TURNSTILE_SECRET` → paste the widget **secret**.
4. `npx wrangler deploy`
5. Test: submit the contact form once yourself; expect the email with
   `Human check: passed`.

## Lead flow

Form (`#quote-form`) → `sendBeacon POST /api/lead` → Worker: honeypot →
Turnstile (if enabled) → KV `lead:<ts>:<uuid>` (365-day TTL) → Resend email
`leads@vbfences.com → sales@vbfences.com` → browser redirects to Acuity with
prefill. The form fill itself is the lead even if no booking follows.

Leads sit in KV namespace `LEADS` (`a4b4ae262a484e3a978e317cb4876727`) —
if email ever goes quiet, check KV before assuming the pipeline is dead.
