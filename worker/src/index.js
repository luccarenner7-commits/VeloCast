// Cloudflare Worker: handles OAuth token exchange server-side for every
// connected provider (Strava, Hammerhead) so their client secrets never
// have to live in the browser-served index.html.
//
// Deploy: set the *_CLIENT_ID vars and *_CLIENT_SECRET secrets (see
// wrangler.toml), then `wrangler deploy` from the worker/ directory (or,
// since this project is deployed via the Cloudflare dashboard rather than
// the CLI: Worker -> Settings -> Variables and Secrets -> Add).

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

// Each provider's token endpoint has slightly different requirements:
// Strava wants a JSON body and doesn't need redirect_uri echoed back;
// Hammerhead wants form-urlencoded and requires redirect_uri on the
// authorization_code grant (per its OpenAPI spec).
const PROVIDERS = {
  strava: {
    tokenUrl: "https://www.strava.com/oauth/token",
    clientIdKey: "STRAVA_CLIENT_ID",
    clientSecretKey: "STRAVA_CLIENT_SECRET",
    bodyType: "json",
    needsRedirectUri: false,
  },
  hammerhead: {
    tokenUrl: "https://api.hammerhead.io/v1/auth/oauth/token",
    clientIdKey: "HAMMERHEAD_CLIENT_ID",
    clientSecretKey: "HAMMERHEAD_CLIENT_SECRET",
    bodyType: "form",
    needsRedirectUri: true,
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    // GET /hammerhead-api/* -> proxies Hammerhead's REST API. Unlike Strava,
    // Hammerhead's API doesn't send CORS headers, so the browser can't call
    // api.hammerhead.io directly (fails with "Load failed"/"Failed to
    // fetch"). Server-to-server requests aren't subject to CORS, so this
    // Worker fetches on the browser's behalf and adds its own CORS headers
    // to the response. The bearer token is only relayed, never stored.
    if (request.method === "GET" && url.pathname.startsWith("/hammerhead-api/")) {
      if (!hasAllowedOrigin(request, env)) {
        return jsonResponse({ error: "forbidden" }, 403, env);
      }
      const targetPath = url.pathname.slice("/hammerhead-api".length);
      const targetUrl = "https://api.hammerhead.io/v1/api" + targetPath + url.search;
      const auth = request.headers.get("Authorization");
      const upstreamRes = await fetch(targetUrl, {
        headers: auth ? { Authorization: auth } : {},
      });
      const data = await upstreamRes.text();
      const upstreamContentType = upstreamRes.headers.get("Content-Type") || "application/json";
      return new Response(data, {
        status: upstreamRes.status,
        headers: { "Content-Type": upstreamContentType, ...corsHeaders(env) },
      });
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

    const { provider, code, refresh_token, redirect_uri } = body || {};
    const config = PROVIDERS[provider || "strava"];
    if (!config) {
      return jsonResponse({ error: "unknown_provider" }, 400, env);
    }
    if (!code && !refresh_token) {
      return jsonResponse({ error: "code_or_refresh_token_required" }, 400, env);
    }

    const params = {
      client_id: env[config.clientIdKey],
      client_secret: env[config.clientSecretKey],
      grant_type: code ? "authorization_code" : "refresh_token",
    };
    if (code) params.code = code;
    if (refresh_token) params.refresh_token = refresh_token;
    if (config.needsRedirectUri && redirect_uri) params.redirect_uri = redirect_uri;

    const fetchOptions = { method: "POST" };
    if (config.bodyType === "form") {
      fetchOptions.headers = { "Content-Type": "application/x-www-form-urlencoded" };
      fetchOptions.body = new URLSearchParams(params).toString();
    } else {
      fetchOptions.headers = { "Content-Type": "application/json" };
      fetchOptions.body = JSON.stringify(params);
    }

    const providerRes = await fetch(config.tokenUrl, fetchOptions);
    const data = await providerRes.json();
    return jsonResponse(data, providerRes.status, env);
  },
};
