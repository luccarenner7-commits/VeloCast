// Cloudflare Worker: handles the Strava OAuth token exchange server-side so
// STRAVA_CLIENT_SECRET never has to live in the browser-served index.html.
//
// Deploy: set env.STRAVA_CLIENT_ID / env.STRAVA_CLIENT_SECRET (see wrangler.toml
// and `wrangler secret put`), then `wrangler deploy` from the worker/ directory.

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405, env);
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

    const stravaRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });

    const data = await stravaRes.json();
    return jsonResponse(data, stravaRes.status, env);
  },
};
