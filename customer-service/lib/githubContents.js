/**
 * githubContents.js — commit one file to a GitHub repo through the REST
 * Contents API, only when its content actually changed.
 *
 * Why this exists next to themeAssetPublish.js: the worktree + PR flow needs
 * a local checkout of the theme repo and the `gh` CLI, which exist on Jamie's
 * machine and nowhere else. The nightly sync runs on Railway, where the only
 * thing available is an HTTPS call with a token. Writing straight to `main`
 * is fine for generated data assets: the Shopify GitHub integration deploys
 * `main` within about 30 seconds either way, and a data file has no review
 * step to skip.
 *
 * Auth: a fine-grained personal access token with Contents read/write on the
 * target repo, in GITHUB_TOKEN (or GH_TOKEN). `hasGithubToken()` lets callers
 * fall back to the worktree flow when it is absent.
 */

const API = 'https://api.github.com';

function githubToken(env = process.env) {
  return env.GITHUB_TOKEN || env.GH_TOKEN || null;
}

function hasGithubToken(env = process.env) {
  return !!githubToken(env);
}

/**
 * Deep equality that ignores the named top-level keys, for "did the data
 * change or only its timestamp?" Arrays keep their order (position is
 * meaning in a price list). Pure.
 */
function sameIgnoringKeys(a, b, keys = []) {
  const strip = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const out = {};
    for (const k of Object.keys(v)) if (!keys.includes(k)) out[k] = v[k];
    return out;
  };
  return canonical(strip(a)) === canonical(strip(b));
}

/** Stable serialisation (sorted object keys, arrays in order). Pure. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

async function request(method, url, { token, body } = {}, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 404) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${method} ${url.replace(API, '')} → ${res.status}: ${json.message || 'no detail'}`);
  return json;
}

/**
 * Write `content` (an object, serialised as pretty JSON) to `path` on
 * `branch`, unless the file already holds the same data ignoring
 * `ignoreKeys`. Returns { noOp, sha, commitSha, commitUrl }.
 */
async function putJsonIfChanged({
  owner, repo, path, branch = 'main', content, message, ignoreKeys = [],
  token = githubToken(), fetchImpl = fetch,
} = {}) {
  if (!token) throw new Error('GITHUB_TOKEN (or GH_TOKEN) is not set');
  if (!owner || !repo || !path) throw new Error('owner, repo and path are required');
  const url = `${API}/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

  const existing = await request('GET', `${url}?ref=${encodeURIComponent(branch)}`, { token }, fetchImpl);
  let sha = null;
  if (existing?.content) {
    sha = existing.sha;
    try {
      const current = JSON.parse(Buffer.from(existing.content, 'base64').toString('utf8'));
      if (sameIgnoringKeys(current, content, ignoreKeys)) return { noOp: true, sha, commitSha: null, commitUrl: null };
    } catch {
      // Unparseable file on the branch: overwrite it.
    }
  }

  const text = JSON.stringify(content, null, 2) + '\n';
  const res = await request('PUT', url, {
    token,
    body: {
      message,
      content: Buffer.from(text, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    },
  }, fetchImpl);
  return {
    noOp: false,
    sha: res?.content?.sha || null,
    commitSha: res?.commit?.sha || null,
    commitUrl: res?.commit?.html_url || null,
  };
}

module.exports = { githubToken, hasGithubToken, sameIgnoringKeys, canonical, putJsonIfChanged };
