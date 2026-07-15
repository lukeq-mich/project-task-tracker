/*
 * Project Task Tracker — GitHub write proxy (Cloudflare Worker)
 * ---------------------------------------------------------------------------
 * Purpose: let every signed-in user's edits reach the GitHub repository,
 * without ever sending a GitHub token to any browser.
 *
 * How it works:
 *   1. The static site (index.html) already signs users in with Google and
 *      holds a short-lived Google ID token for the session.
 *   2. When the user saves something, the app POSTs to this Worker along
 *      with that ID token in the Authorization header.
 *   3. This Worker independently verifies the ID token against Google's
 *      public keys (no library needed — Cloudflare Workers has Web Crypto),
 *      confirms it is unexpired, verified, and on the allowed domain, and
 *      only THEN commits the write to GitHub using a secret token that is
 *      configured here and never leaves the Worker.
 *
 * Endpoints:
 *   POST /sync    — body: { data: <full data.json object> }
 *                    Commits the given object as data/data.json.
 *   POST /upload  — body: { filename: string, dataUrl: "data:image/...;base64,...." }
 *                    Commits the image under cover-images/ and returns its
 *                    raw GitHub URL.
 *
 * Required Worker secrets/variables (set in the Cloudflare dashboard):
 *   GITHUB_TOKEN     - fine-grained PAT, Contents: Read & write, this repo only
 *   GITHUB_REPO      - "owner/repo", e.g. "lukeq-mich/project-task-tracker"
 *   GOOGLE_CLIENT_ID - the OAuth client ID used by the site's Sign-in-with-Google
 *   ALLOWED_DOMAIN   - "umich.edu"
 *   ALLOWED_ORIGIN   - the site origin, e.g. "https://lukeq-mich.github.io"
 */

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let cachedCerts = null, cachedCertsAt = 0;

async function getGoogleCerts() {
  const now = Date.now();
  if (cachedCerts && now - cachedCertsAt < 60 * 60 * 1000) return cachedCerts;
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new Error('Could not fetch Google certs');
  cachedCerts = await res.json();
  cachedCertsAt = now;
  return cachedCerts;
}

function b64urlToUint8Array(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(b64url.length + (4 - (b64url.length % 4)) % 4, '=');
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function b64urlToJson(b64url) {
  return JSON.parse(new TextDecoder().decode(b64urlToUint8Array(b64url)));
}

// Verifies a Google-issued ID token (JWT) using Google's published JWKS.
// Throws on any failure; returns the decoded payload on success.
async function verifyGoogleIdToken(idToken, env) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [headerB64, payloadB64, sigB64] = parts;
  const header = b64urlToJson(headerB64);
  const payload = b64urlToJson(payloadB64);

  const certs = await getGoogleCerts();
  const jwk = certs.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Signing key not found');

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = b64urlToUint8Array(sigB64);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signedData);
  if (!ok) throw new Error('Invalid signature');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('Token expired');
  if (payload.aud !== env.GOOGLE_CLIENT_ID) throw new Error('Wrong audience');
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') throw new Error('Wrong issuer');
  if (!payload.email_verified) throw new Error('Email not verified');

  const domain = (env.ALLOWED_DOMAIN || '').toLowerCase();
  const email = String(payload.email || '').toLowerCase();
  const domainOk = (payload.hd && String(payload.hd).toLowerCase() === domain) || email.endsWith('@' + domain);
  if (!domainOk) throw new Error(`Not an @${domain} account`);

  return payload;
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };
}
function json(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

async function githubGetSha(path, env) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'project-task-tracker-worker' },
  });
  if (!res.ok) return undefined;
  const j = await res.json();
  return j.sha;
}
async function githubPutFile(path, base64Content, message, env) {
  const sha = await githubGetSha(path, env);
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'project-task-tracker-worker' },
    body: JSON.stringify({ message, content: base64Content, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub write failed (${res.status}): ${t.slice(0, 300)}`);
  }
  return res.json();
}

// A light sanity check on the incoming data.json shape — not full validation,
// just enough to stop obviously malformed payloads from being committed.
function looksLikeValidData(d) {
  return d && typeof d === 'object'
    && d.meta && d.enums && d.auth
    && Array.isArray(d.users) && Array.isArray(d.projects) && Array.isArray(d.tasks)
    && d.sequences && typeof d.sequences === 'object';
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(env) });
    const url = new URL(request.url);

    let payload;
    try {
      const authHeader = request.headers.get('Authorization') || '';
      const idToken = authHeader.replace(/^Bearer\s+/i, '');
      if (!idToken) return json({ error: 'Missing Google ID token' }, 401, env);
      payload = await verifyGoogleIdToken(idToken, env);
    } catch (e) {
      return json({ error: 'Auth failed: ' + e.message }, 401, env);
    }

    try {
      if (request.method === 'POST' && url.pathname === '/sync') {
        const body = await request.json();
        if (!looksLikeValidData(body.data)) return json({ error: 'Malformed data payload' }, 400, env);
        const content = JSON.stringify(body.data, null, 2);
        const base64 = btoa(unescape(encodeURIComponent(content)));
        await githubPutFile('data/data.json', base64, `Update data (via ${payload.email})`, env);
        return json({ ok: true }, 200, env);
      }

      if (request.method === 'POST' && url.pathname === '/upload') {
        const body = await request.json();
        const { filename, dataUrl } = body;
        if (!filename || !dataUrl || !dataUrl.startsWith('data:')) return json({ error: 'Malformed upload payload' }, 400, env);
        const base64 = dataUrl.split(',')[1];
        const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `cover-images/${Date.now()}-${safe}`;
        const result = await githubPutFile(path, base64, `Upload cover image ${safe} (via ${payload.email})`, env);
        return json({ ok: true, url: result.content.download_url }, 200, env);
      }

      return json({ error: 'Not found' }, 404, env);
    } catch (e) {
      return json({ error: e.message }, 500, env);
    }
  },
};
