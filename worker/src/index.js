// Cloudflare Worker: OAuth-Token-Austausch für Strava und Hammerhead
// serverseitig (Client Secrets bleiben aus dem Browser raus), plus Proxy
// für den Hammerhead-.fit-Upload -- ein Live-Test bestätigte, dass
// api.hammerhead.io/v1/api/workouts/file kein Access-Control-Allow-Origin
// für die GitHub-Pages-Origin setzt (fetch() schlägt mit "Failed to fetch"
// fehl), muss also ebenfalls hier durchgereicht werden.
//
// Routen (ein Worker, nach Pfad):
//   POST /                       Strava OAuth Token-Austausch (unverändert)
//   POST /hammerhead/token       Hammerhead OAuth Token-Austausch
//   POST /hammerhead/upload      Hammerhead .fit-Workout-Upload (CORS-Proxy)
//   GET  /hammerhead/client-id   Liefert die (nicht geheime) Client ID an den
//                                Browser -- sie steht ohnehin öffentlich in
//                                der OAuth-Redirect-URL, daher keine
//                                zusätzliche Prüfung nötig; spart eine zweite
//                                Pflegestelle in index.html.
//
// Deploy: set STRAVA_CLIENT_ID / HAMMERHEAD_CLIENT_ID (see wrangler.toml)
// and the STRAVA_CLIENT_SECRET / HAMMERHEAD_CLIENT_SECRET secrets, then
// `wrangler deploy` from the worker/ directory (or, since this project is
// deployed via the Cloudflare dashboard rather than the CLI: Worker ->
// Settings -> Variables and Secrets -> Add).

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

// CORS headers alone only stop browser JS from reading the response — they
// don't stop a direct (non-browser) request from a stolen refresh_token
// being redeemed here. Checking Origin server-side isn't foolproof (a
// scripted attacker can still set an arbitrary Origin header), but it closes
// off casual/browser-based abuse and costs nothing for legitimate callers.
function hasAllowedOrigin(request, env) {
  const allowed = env.ALLOWED_ORIGIN;
  if (!allowed || allowed === "*") return true;
  return request.headers.get("Origin") === allowed;
}

async function handleStravaToken(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid_json" }, 400, env); }
  const { code, refresh_token } = body || {};
  if (!code && !refresh_token) return jsonResponse({ error: "code_or_refresh_token_required" }, 400, env);
  const params = {
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    grant_type: code ? "authorization_code" : "refresh_token",
  };
  if (code) params.code = code;
  if (refresh_token) params.refresh_token = refresh_token;
  const providerRes = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return jsonResponse(await providerRes.json(), providerRes.status, env);
}

// Hammerheads /oauth/token akzeptiert laut Spec nur
// application/x-www-form-urlencoded -- Browser->Worker bleibt JSON (analog
// zur Strava-Route), nur der ausgehende Call an Hammerhead wird umkodiert.
async function handleHammerheadToken(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid_json" }, 400, env); }
  const { code, refresh_token, redirect_uri } = body || {};
  if (!code && !refresh_token) return jsonResponse({ error: "code_or_refresh_token_required" }, 400, env);
  const params = new URLSearchParams({
    client_id: env.HAMMERHEAD_CLIENT_ID,
    client_secret: env.HAMMERHEAD_CLIENT_SECRET,
    grant_type: code ? "authorization_code" : "refresh_token",
  });
  if (code) { params.set("code", code); params.set("redirect_uri", redirect_uri || ""); }
  if (refresh_token) params.set("refresh_token", refresh_token);
  const providerRes = await fetch("https://api.hammerhead.io/v1/auth/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  return jsonResponse(await providerRes.json(), providerRes.status, env);
}

// Proxied nur wegen fehlender CORS-Freigabe, nicht wegen Auth -- der
// Browser hat bereits einen gültigen access_token und schickt ihn direkt
// als Bearer-Header mit.
async function handleHammerheadUpload(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return jsonResponse({ error: "missing_authorization" }, 401, env);
  const url = new URL(request.url);
  const plannedDate = url.searchParams.get("plannedDate");
  const filename = url.searchParams.get("filename") || "workout.fit";
  if (!/\.(fit|zwo)$/i.test(filename)) return jsonResponse({ error: "invalid_filename" }, 400, env);
  const fitBytes = await request.arrayBuffer();
  if (fitBytes.byteLength === 0) return jsonResponse({ error: "empty_body" }, 400, env);
  const form = new FormData();
  form.append("file", new Blob([fitBytes], { type: "application/octet-stream" }), filename);
  const hhUrl = new URL("https://api.hammerhead.io/v1/api/workouts/file");
  if (plannedDate) hhUrl.searchParams.set("plannedDate", plannedDate);
  const providerRes = await fetch(hhUrl.toString(), {
    method: "POST",
    headers: { Authorization: auth },
    body: form,
  });
  return jsonResponse(await providerRes.json(), providerRes.status, env);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });

    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/hammerhead/client-id") {
      return jsonResponse({ client_id: env.HAMMERHEAD_CLIENT_ID }, 200, env);
    }

    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, env);
    if (!hasAllowedOrigin(request, env)) return jsonResponse({ error: "forbidden" }, 403, env);
    if (pathname === "/hammerhead/token") return handleHammerheadToken(request, env);
    if (pathname === "/hammerhead/upload") return handleHammerheadUpload(request, env);
    return handleStravaToken(request, env);
  },
};
