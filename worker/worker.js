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

// A light structural sanity check — not authorization, just shape.
function looksLikeValidData(d) {
  return d && typeof d === 'object'
    && d.meta && d.enums && d.auth
    && Array.isArray(d.users) && Array.isArray(d.projects) && Array.isArray(d.tasks)
    && d.sequences && typeof d.sequences === 'object';
}

// ---- Server-side authorization ------------------------------------------------
// The Worker is the real gatekeeper. It never trusts the requester's role from
// the payload; it looks the requester up in the COMMITTED state by verified email
// and validates the committed->incoming diff against that role.

const ROLE = { ADMIN:'RoleKey0', EXEC:'RoleKey1', LEAD:'RoleKey2', MEMBER:'RoleKey3' };
const isAdmin = r => r === ROLE.ADMIN;
const isExec = r => r === ROLE.EXEC;
const isLead = r => r === ROLE.LEAD;
const isMember = r => r === ROLE.MEMBER;
const isAdminOrExec = r => isAdmin(r) || isExec(r);
const norm = v => String(v == null ? '' : v).trim().toLowerCase();

const byId = (arr) => { const m = new Map(); (arr||[]).forEach(x => m.set(x.id, x)); return m; };
const stable = (o) => JSON.stringify(o);

// Returns { ok:true } or { ok:false, reasons:[...] }.
function authorizeSync(committed, incoming, requesterEmail, env) {
  const reasons = [];
  const adminEmails = (committed.auth && committed.auth.adminEmails || env.ADMIN_EMAILS_FALLBACK || '')
    .toString().split(',').map(norm).filter(Boolean);

  // Identify requester in COMMITTED state (never from the incoming payload).
  const committedUsers = committed.users || [];
  const requester = committedUsers.find(u => norm(u.email) === norm(requesterEmail));

  // Config blocks are immutable via sync (auth/enums/meta.theme name etc. change by repo edit only).
  if (stable(committed.auth) !== stable(incoming.auth)) reasons.push('The auth configuration cannot be changed through the app.');
  if (stable(committed.enums) !== stable(incoming.enums)) reasons.push('Role/status definitions cannot be changed through the app.');

  const cU = byId(committedUsers), iU = byId(incoming.users);
  const cP = byId(committed.projects), iP = byId(incoming.projects);
  const cT = byId(committed.tasks), iT = byId(incoming.tasks);

  // ---- First-time self-insert path -------------------------------------------
  if (!requester) {
    // The only writes an unknown user may make: insert exactly their own user record.
    // Everything else (projects, tasks, other users) must be byte-identical to committed.
    const addedUsers = [...iU.values()].filter(u => !cU.has(u.id));
    const removedUsers = [...cU.values()].filter(u => !iU.has(u.id));
    const changedUsers = [...iU.values()].filter(u => cU.has(u.id) && stable(cU.get(u.id)) !== stable(u));

    if (removedUsers.length || changedUsers.length) reasons.push('New accounts may not modify or remove existing users.');
    if (addedUsers.length !== 1) reasons.push('A new sign-in may only create its own account.');
    else {
      const nu = addedUsers[0];
      if (norm(nu.email) !== norm(requesterEmail)) reasons.push('A new account must match your signed-in email.');
      const allowedRole = adminEmails.includes(norm(requesterEmail)) ? ROLE.ADMIN : ROLE.MEMBER;
      if (nu.roleKey !== allowedRole) reasons.push(`New accounts are created as ${allowedRole===ROLE.ADMIN?'Admin (via adminEmails)':'Member'}.`);
      if (nu.projectMembership) reasons.push('New accounts start with no project membership.');
    }
    if (stable(committed.projects) !== stable(incoming.projects)) reasons.push('New accounts may not change projects.');
    if (stable(committed.tasks) !== stable(incoming.tasks)) reasons.push('New accounts may not change tasks.');
    return reasons.length ? { ok:false, reasons } : { ok:true };
  }

  const role = requester.roleKey;

  // ---- USERS diff -------------------------------------------------------------
  const addedUsers = [...iU.values()].filter(u => !cU.has(u.id));
  const removedUsers = [...cU.values()].filter(u => !iU.has(u.id));
  const changedUsers = [...iU.values()].filter(u => cU.has(u.id) && stable(cU.get(u.id)) !== stable(u));

  // Adding brand-new users (other than the requester's own already-present record):
  addedUsers.forEach(u => {
    const selfInsert = norm(u.email) === norm(requesterEmail);
    if (selfInsert) {
      // requester already exists in committed, so a self "add" shouldn't happen; treat as admin-only.
      if (!isAdmin(role)) reasons.push('Only admins can add users.');
    } else if (!isAdmin(role)) {
      reasons.push('Only admins can add users.');
    }
  });
  if (removedUsers.length && !isAdmin(role)) reasons.push('Only admins can delete users.');

  changedUsers.forEach(u => {
    const before = cU.get(u.id);
    const roleChanged = before.roleKey !== u.roleKey;
    const identityChanged = norm(before.email) !== norm(u.email) || before.title !== u.title;
    const membershipChanged = stable(before.projectMembership||null) !== stable(u.projectMembership||null);

    if (roleChanged && !isAdmin(role)) reasons.push(`Only admins can change roles (attempted on ${before.title||before.email}).`);
    // Identity edits to other people are admin-only; editing your own name is allowed.
    if (identityChanged && !isAdmin(role) && u.id !== requester.id) reasons.push('Only admins can edit other users.');
    // Membership changes: admins/execs manage anyone; a member may only clear their OWN membership (leave a project).
    if (membershipChanged && !isAdminOrExec(role)) {
      const own = u.id === requester.id;
      const clearingOnly = own && (u.projectMembership == null);
      if (!clearingOnly) reasons.push('Only admins or executives can assign project membership.');
    }
  });

  // Never allow the last admin to be removed/demoted (integrity guard, all roles).
  const committedAdmins = committedUsers.filter(u => isAdmin(u.roleKey)).length;
  const incomingAdmins = (incoming.users||[]).filter(u => isAdmin(u.roleKey)).length;
  if (committedAdmins >= 1 && incomingAdmins === 0) reasons.push('The last admin cannot be removed or demoted.');

  // ---- PROJECTS diff ----------------------------------------------------------
  const addedProjects = [...iP.values()].filter(p => !cP.has(p.id));
  const removedProjects = [...cP.values()].filter(p => !iP.has(p.id));
  const changedProjects = [...iP.values()].filter(p => cP.has(p.id) && stable(cP.get(p.id)) !== stable(p));
  if ((addedProjects.length || removedProjects.length || changedProjects.length) && !isAdminOrExec(role)) {
    reasons.push('Only admins or executives can create, edit, or delete projects.');
  }

  // ---- TASKS diff -------------------------------------------------------------
  const addedTasks = [...iT.values()].filter(t => !cT.has(t.id));
  const removedTasks = [...cT.values()].filter(t => !iT.has(t.id));
  const changedTasks = [...iT.values()].filter(t => cT.has(t.id) && stable(cT.get(t.id)) !== stable(t));

  const leadsProject = (projId) => {
    const p = cP.get(projId) || iP.get(projId);
    return p && p.projectLead && p.projectLead.id === requester.id;
  };

  if ((addedTasks.length || removedTasks.length) && !(isAdminOrExec(role) || isLead(role))) {
    reasons.push('Only admins, executives, or project leads can create or delete tasks.');
  }
  // Leads may only add/delete tasks within projects they lead.
  if (isLead(role) && !isAdminOrExec(role)) {
    addedTasks.concat(removedTasks).forEach(t => {
      const pid = t.associatedProject && t.associatedProject.id;
      if (!leadsProject(pid)) reasons.push('Project leads can only add or delete tasks in projects they lead.');
    });
  }
  changedTasks.forEach(t => {
    const before = cT.get(t.id);
    if (isAdminOrExec(role)) return;
    if (isLead(role) && leadsProject(before.associatedProject && before.associatedProject.id)) return;
    if (isMember(role)) {
      // Members may only edit status/completionDate of tasks assigned to them.
      const own = before.assignedTo && before.assignedTo.id === requester.id;
      const onlyAllowedFields = ['statusKey','completionDate'].every(() => true);
      const changedKeys = Object.keys({...before, ...t}).filter(k => stable(before[k]) !== stable(t[k]));
      const disallowed = changedKeys.filter(k => k !== 'statusKey' && k !== 'completionDate');
      if (!own) reasons.push('Members can only update tasks assigned to them.');
      else if (disallowed.length) reasons.push(`Members can only change task status and completion date (attempted: ${disallowed.join(', ')}).`);
      return;
    }
    reasons.push('You are not permitted to edit this task.');
  });

  // De-duplicate reasons for a clean message.
  return reasons.length ? { ok:false, reasons:[...new Set(reasons)] } : { ok:true };
}

async function githubGetFile(path, env) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'project-task-tracker-worker' },
  });
  if (!res.ok) return { sha: undefined, json: undefined };
  const j = await res.json();
  const content = j.content ? decodeURIComponent(escape(atob(j.content.replace(/\n/g, '')))) : undefined;
  let parsed;
  try { parsed = content ? JSON.parse(content) : undefined; } catch { parsed = undefined; }
  return { sha: j.sha, json: parsed };
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

        // Optimistic-concurrency read-modify-write with a small retry loop.
        for (let attempt = 0; attempt < 3; attempt++) {
          const { sha, json: committed } = await githubGetFile('data/data.json', env);
          if (!committed) return json({ error: 'Could not read current data from the repository.' }, 502, env);

          const decision = authorizeSync(committed, body.data, payload.email, env);
          if (!decision.ok) return json({ error: 'Change not permitted for your role.', blocked: decision.reasons }, 403, env);

          const content = JSON.stringify(body.data, null, 2);
          const base64 = btoa(unescape(encodeURIComponent(content)));
          const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/data/data.json`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'project-task-tracker-worker' },
            body: JSON.stringify({ message: `Update data (via ${payload.email})`, content: base64, ...(sha ? { sha } : {}) }),
          });
          if (res.ok) return json({ ok: true, data: body.data }, 200, env);
          if (res.status === 409) continue; // sha moved; someone else wrote — retry against fresh state
          const t = await res.text();
          throw new Error(`GitHub write failed (${res.status}): ${t.slice(0, 300)}`);
        }
        return json({ error: 'Sync kept colliding with concurrent updates. Reload and try again.' }, 409, env);
      }

      if (request.method === 'POST' && url.pathname === '/upload') {
        const body = await request.json();
        const { filename, dataUrl } = body;
        if (!filename || !dataUrl || !dataUrl.startsWith('data:')) return json({ error: 'Malformed upload payload' }, 400, env);
        // Uploading a cover image requires an existing project-editing role.
        const { json: committed } = await githubGetFile('data/data.json', env);
        const requester = (committed && committed.users || []).find(u => norm(u.email) === norm(payload.email));
        if (!requester || !isAdminOrExec(requester.roleKey)) {
          return json({ error: 'Only admins or executives can upload cover images.' }, 403, env);
        }
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
