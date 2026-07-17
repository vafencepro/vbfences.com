/**
 * VB Fences unified Worker — vbfences.com
 *
 * Serves the static site (Workers Static Assets, ./public) and handles:
 *   POST /api/lead   — quote form capture → KV + Resend email to sales@
 *   POST /api/track  — click/conversion events → KV (30-day TTL)
 *   GET  /api/health — liveness
 *
 * Secrets (set via `wrangler secret put`, never in this file):
 *   RESEND_API_KEY    — lead email delivery
 *   TURNSTILE_SECRET  — optional; when set, /api/lead verifies the
 *                       Turnstile token. Failed/missing verification
 *                       NEVER drops a lead: it is stored flagged and
 *                       emailed with a [SUSPECT] subject prefix.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS" && path.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (path === "/api/health" && request.method === "GET") {
      return json({ ok: true, ts: Date.now() }, 200);
    }
    if (path === "/api/track" && request.method === "POST") {
      return handleTrack(request, env, ctx);
    }
    if (path === "/api/lead" && request.method === "POST") {
      return handleLead(request, env, ctx);
    }
    if (path.startsWith("/api/")) {
      return json({ ok: false, error: "Not found" }, 404);
    }

    // Legacy/alias URLs → canonical extensionless URLs, permanent.
    // (Static Assets would otherwise answer .html paths with a cached 307,
    // which tells crawlers the .html URLs are still canonical. 301 here wins.)
    const REDIRECTS = {
      "/index.html": "/",
      "/residential-fencing.html": "/residential-fencing",
      "/commercial-fencing.html": "/commercial-fencing",
      "/contact.html": "/contact",
      "/company/about.html": "/company/about",
      "/services/fence-installation.html": "/services/fence-installation",
      "/services/fence-repair.html": "/services/fence-repair",
      "/materials/wood-fencing.html": "/materials/wood-fencing",
      "/materials/vinyl-fencing.html": "/materials/vinyl-fencing",
      "/materials/aluminum-fencing.html": "/materials/aluminum-fencing",
      "/materials/chain-link-fencing.html": "/materials/chain-link-fencing",
      "/materials/pool-fencing.html": "/materials/pool-fencing",
      "/locations/virginia-beach-va.html": "/locations/virginia-beach-va",
      "/locations/norfolk-va.html": "/locations/norfolk-va",
      "/locations/chesapeake-va.html": "/locations/chesapeake-va",
      "/locations/service-areas.html": "/locations/service-areas",
      "/locations/suffolk-va": "/locations/service-areas",
      "/locations/suffolk-va.html": "/locations/service-areas",
      "/locations/portsmouth-va": "/locations/service-areas",
      "/locations/portsmouth-va.html": "/locations/service-areas"
    };
    if (REDIRECTS[path]) {
      return Response.redirect(url.origin + REDIRECTS[path], 301);
    }

    const response = await env.ASSETS.fetch(request);
    return withSecurityHeaders(response, path);
  }
};

async function handleTrack(request, env, ctx) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: true }, 200);
  }
  if (env.LEADS) {
    const id = crypto.randomUUID();
    const event = {
      id,
      ts: Date.now(),
      e: String(data.e || "unknown").slice(0, 32),
      p: data.p || {},
      u: String(data.u || "").slice(0, 200),
      ip: request.headers.get("cf-connecting-ip") || "",
      ua: (request.headers.get("user-agent") || "").slice(0, 200),
      ref: (request.headers.get("referer") || "").slice(0, 200),
      country: request.cf?.country || "",
      colo: request.cf?.colo || ""
    };
    ctx.waitUntil(
      env.LEADS.put(`event:${event.ts}:${id}`, JSON.stringify(event), {
        expirationTtl: 60 * 60 * 24 * 30,
        metadata: { e: event.e }
      }).catch(() => {})
    );
  }
  return json({ ok: true }, 200);
}

async function handleLead(request, env, ctx) {
  const origin = request.headers.get("origin") || "";
  if (!/^https:\/\/(www\.)?vbfences\.com$/.test(origin)) {
    return json({ ok: false, error: "origin" }, 403);
  }
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }
  // Honeypot: silently accept and discard.
  if (data.website && String(data.website).trim() !== "") {
    return json({ ok: true }, 200);
  }

  // Turnstile verification — only when the secret is configured.
  // verified: true = human-checked, false = failed/missing token, null = Turnstile not enabled.
  let verified = null;
  if (env.TURNSTILE_SECRET) {
    verified = false;
    const token = String(data.token || "").slice(0, 2048);
    if (token) {
      try {
        const vr = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            secret: env.TURNSTILE_SECRET,
            response: token,
            remoteip: request.headers.get("cf-connecting-ip") || undefined
          })
        });
        const vj = await vr.json();
        verified = vj.success === true;
      } catch (e) {
        console.error("turnstile siteverify threw", e);
        verified = false;
      }
    }
  }

  const lead = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    name: String(data.name || "").trim().slice(0, 120),
    email: String(data.email || "").trim().slice(0, 200),
    phone: String(data.phone || "").trim().slice(0, 40),
    service: String(data.service || "").trim().slice(0, 80),
    address: String(data.address || "").trim().slice(0, 200),
    details: String(data.details || data.message || "").trim().slice(0, 2000),
    page: String(data.u || "").slice(0, 200),
    ip: request.headers.get("cf-connecting-ip") || "",
    ua: (request.headers.get("user-agent") || "").slice(0, 200),
    ref: (request.headers.get("referer") || "").slice(0, 200),
    country: request.cf?.country || "",
    verified
  };
  if (!lead.phone && !lead.email) {
    return json({ ok: false, error: "no_contact" }, 400);
  }
  if (env.LEADS) {
    ctx.waitUntil(
      env.LEADS.put(`lead:${lead.ts}:${lead.id}`, JSON.stringify(lead), {
        expirationTtl: 60 * 60 * 24 * 365,
        metadata: { phone: lead.phone, service: lead.service, verified: lead.verified }
      }).catch((e) => console.error("KV put failed", e, "lead", lead.id))
    );
  }
  if (env.RESEND_API_KEY) {
    ctx.waitUntil(sendLeadEmail(env.RESEND_API_KEY, lead));
  } else {
    console.error("RESEND_API_KEY missing; lead saved to KV only", lead.id);
  }
  return json({ ok: true }, 200);
}

async function sendLeadEmail(apiKey, lead) {
  const suspect = lead.verified === false ? "[SUSPECT] " : "";
  const subject = `${suspect}New quote request — ${lead.name || "unknown"}${lead.service ? " · " + lead.service : ""}`;
  const text = [
    `New lead from vbfences.com`,
    `---`,
    `Name:    ${lead.name || "(not given)"}`,
    `Phone:   ${lead.phone || "(not given)"}`,
    `Email:   ${lead.email || "(not given)"}`,
    `Service: ${lead.service || "(not given)"}`,
    `Address: ${lead.address || "(not given)"}`,
    `Details: ${lead.details || "(none)"}`,
    ``,
    `Page:    ${lead.page}`,
    `Country: ${lead.country}`,
    `IP:      ${lead.ip}`,
    `Human check: ${lead.verified === true ? "passed" : lead.verified === false ? "FAILED — treat as possible spam" : "not enabled"}`,
    `Time:    ${new Date(lead.ts).toISOString()}`,
    `Lead ID: ${lead.id}`,
    ``,
    `Note: customer was then redirected to Acuity to pick a time.`,
    `If no booking came through, call them — the form fill itself is the lead.`
  ].join("\n");
  const body = {
    from: "VB Fences Website <leads@vbfences.com>",
    to: ["sales@vbfences.com"],
    subject,
    text,
    ...(lead.email ? { reply_to: lead.email } : {})
  };
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error("Resend non-2xx", r.status, errText, "lead", lead.id);
    }
  } catch (e) {
    console.error("Resend fetch threw", e, "lead", lead.id);
  }
}

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const allow = /^https:\/\/(www\.)?vbfences\.com$/.test(origin) ? origin : "https://vbfences.com";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "origin"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function withSecurityHeaders(response, pathname) {
  const headers = new Headers(response.headers);
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://embed.acuityscheduling.com https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.acuityscheduling.com; font-src 'self'; frame-src https://vbfences.as.me https://*.acuityscheduling.com https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (/\.(css|js|webp|svg|png|jpg|jpeg|avif|woff2)$/i.test(pathname)) {
    // Safe to cache forever: css/js URLs carry a ?v= version (bump on change).
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  // HTML/xml/txt: leave the asset layer's `max-age=0, must-revalidate` —
  // ETag revalidation keeps pages always-fresh with no manual purges.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
