// Cloudflare Worker: handles Strava's OAuth token exchange server-side so
// the client secret never has to live in the browser-served index.html.
//
// Deploy: set STRAVA_CLIENT_ID (see wrangler.toml) and the
// STRAVA_CLIENT_SECRET secret, then `wrangler deploy` from the worker/
// directory (or, since this project is deployed via the Cloudflare
// dashboard rather than the CLI: Worker -> Settings -> Variables and
// Secrets -> Add).

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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405, env);
    }
    if (!hasAllowedOrigin(request, env)) {
      return jsonResponse({ error: "forbidden" }, 403, env);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400, env);
    }

    const { code, refresh_token } = body || {};
    if (!code && !refresh_token) {
      return jsonResponse({ error: "code_or_refresh_token_required" }, 400, env);
    }

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
    const data = await providerRes.json();
    return jsonResponse(data, providerRes.status, env);
  },
};
