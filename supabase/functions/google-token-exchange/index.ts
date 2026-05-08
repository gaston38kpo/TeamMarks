// supabase/functions/google-token-exchange/index.ts
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  let body: { code?: string; redirect_uri?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'missing_fields', message: 'Request body must be valid JSON' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const { code, redirect_uri } = body;

  if (!code || !redirect_uri) {
    return new Response(
      JSON.stringify({ error: 'missing_fields', message: 'Both "code" and "redirect_uri" are required' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLECLIENTSECRET');

  if (!clientId || !clientSecret) {
    console.error('[google-token-exchange] Missing env vars GOOGLE_CLIENT_ID or GOOGLECLIENTSECRET');
    return new Response(
      JSON.stringify({ error: 'server_misconfiguration', message: 'Server misconfiguration' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.json().catch(() => ({}));
    // Sanitize: never expose client_secret in logs or responses
    const safeError = typeof errorData.error === 'string' ? errorData.error : 'upstream_error';
    const safeDesc = typeof errorData.error_description === 'string'
      ? errorData.error_description
      : `Google returned ${tokenResponse.status}`;
    console.error('[google-token-exchange] Google error:', safeError, safeDesc);
    return new Response(
      JSON.stringify({ error: 'upstream_error', status: tokenResponse.status }),
      { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const tokens = await tokenResponse.json();

  return new Response(
    JSON.stringify({
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? null,
    }),
    { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
  );
});
