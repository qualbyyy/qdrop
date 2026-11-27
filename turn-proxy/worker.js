export function isAllowedOrigin(origin, allowedOriginEnv) {
  if (!origin || typeof origin !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
    return true;
  }
  const allowed = String(allowedOriginEnv || '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return allowed.includes(parsed.origin);
}

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

export default {
  async fetch(request, env = {}) {
    const origin = request.headers.get('Origin') || '';
    const allowed = isAllowedOrigin(origin, env.ALLOWED_ORIGIN);
    const corsHeaders = allowed ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {};

    if (request.method === 'OPTIONS') {
      if (!allowed) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
    }
    if (!allowed) {
      return jsonResponse({ error: 'Origin not allowed' }, 403);
    }

    const cleanDomain = String(env.METERED_DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const apiKey = String(env.METERED_API_KEY || '').trim();
    if (!cleanDomain || !apiKey) {
      return jsonResponse({ error: 'TURN proxy is not configured' }, 500, corsHeaders);
    }

    try {
      const upstreamUrl = `https://${cleanDomain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`;
      const res = await fetch(upstreamUrl, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        return jsonResponse({ error: 'Upstream TURN provider error', status: res.status }, 502, corsHeaders);
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        return jsonResponse({ error: 'Invalid TURN provider response' }, 502, corsHeaders);
      }
      const iceServers = data
        .filter((item) => item && item.urls)
        .map((item) => ({
          urls: item.urls,
          ...(item.username ? { username: item.username } : {}),
          ...(item.credential ? { credential: item.credential } : {})
        }));
      return jsonResponse({ iceServers }, 200, corsHeaders);
    } catch {
      return jsonResponse({ error: 'Failed to reach TURN provider' }, 502, corsHeaders);
    }
  }
};
