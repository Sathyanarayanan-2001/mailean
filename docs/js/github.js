// GitHub REST client for the private data repository.
// Every call has a timeout and retries transient failures with backoff, so a
// bad network never freezes or breaks the page. Errors carry plain-English
// messages that say what went wrong and how to fix it.

export const STATE_BRANCH = 'mailean-state';
export const COMMANDS_WORKFLOW = 'run-commands.yml';
export const SYNC_WORKFLOW = 'scheduled-triage.yml';
export const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const TOKEN_RE = /^(?:github_pat_[A-Za-z0-9_]{20,255}|ghp_[A-Za-z0-9]{36})$/;
const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export function validateConnection(repo, token) {
  const errors = {};
  const r = String(repo || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  if (!REPO_RE.test(r)) errors.repo = 'Enter the private repository as owner/name, for example Sathyanarayanan-2001/gmail-command-center.';
  const t = String(token || '').trim();
  if (!TOKEN_RE.test(t)) errors.token = 'Paste a fine-grained token. It starts with github_pat_ (see Guide, One-time setup, step 4).';
  return { repo: r, token: t, errors };
}

function friendly(status, body, what) {
  const msg = (body && body.message) || '';
  if (status === 401) return 'GitHub rejected the token. It may have expired or been revoked. Create a new fine-grained token and paste it in Settings.';
  if (status === 403 && /rate limit/i.test(msg)) return 'GitHub rate limit reached. Wait a few minutes, then try again.';
  if (status === 403) return `The token is not allowed to ${what}. Give it access to this repository with Contents: read and Actions: read and write.`;
  if (status === 404) return `Not found while trying to ${what}. Check the repository name, and that the token can see that repository.`;
  if (status === 422) return `GitHub refused the request to ${what}: ${msg || 'invalid input'}.`;
  if (status >= 500) return `GitHub had a server problem (${status}) while trying to ${what}. Try again in a minute.`;
  return `Could not ${what} (HTTP ${status}${msg ? ': ' + msg : ''}).`;
}

export class GitHub {
  constructor(repo, token, { fetchImpl = (...a) => fetch(...a), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 15000 } = {}) {
    this.repo = repo;
    this.token = token;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, accept = 'application/vnd.github+json', what = 'reach GitHub', retries = 3, etag } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const headers = { Accept: accept, Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28' };
        if (body) headers['Content-Type'] = 'application/json';
        if (etag) headers['If-None-Match'] = etag;
        const res = await this.fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, cache: 'no-store' });
        if (res.status === 304) return { status: 304, etag };
        if (res.ok) {
          const text = res.status === 204 ? '' : await res.text();
          return { status: res.status, text, etag: res.headers.get('ETag') };
        }
        let data = null;
        try {
          data = await res.json();
        } catch { /* not JSON */ }
        lastErr = new GitHubError(friendly(res.status, data, what), res.status);
        const retryable = res.status >= 500 || res.status === 429;
        if (!retryable || attempt === retries) throw lastErr;
      } catch (err) {
        if (err instanceof GitHubError) throw err;
        lastErr = new GitHubError(err && err.name === 'AbortError'
          ? `GitHub did not answer within ${this.timeoutMs / 1000} seconds while trying to ${what}. Check your connection.`
          : `No connection to GitHub while trying to ${what}. You can keep working offline; queued actions wait until you are back online.`, 0);
        if (attempt === retries) throw lastErr;
      } finally {
        clearTimeout(timer);
      }
      await this.sleep(Math.min(8000, 500 * 2 ** attempt + Math.random() * 250));
    }
    throw lastErr;
  }

  async json(path, opts) {
    const r = await this.request(path, opts);
    return r.text ? JSON.parse(r.text) : null;
  }

  /** Confirms the token can read the repository, and that it is private. */
  async verifyRepo() {
    const info = await this.json(`/repos/${this.repo}`, { what: 'open the repository' });
    if (!info.private) {
      throw new GitHubError('This repository is public, so anyone could read your email summaries. Make it private in GitHub (Settings, General, Danger zone, Change visibility), then connect again.', 0);
    }
    return info;
  }

  /** Raw file from the state branch; returns {status:304} when unchanged since etag. */
  getStateFile(path, etag) {
    return this.request(`/repos/${this.repo}/contents/${path}?ref=${STATE_BRANCH}`, {
      accept: 'application/vnd.github.raw+json', what: `read ${path}`, etag,
    });
  }

  async dispatch(payload) {
    await this.request(`/repos/${this.repo}/actions/workflows/${COMMANDS_WORKFLOW}/dispatches`, {
      method: 'POST', what: 'start the command workflow', retries: 1,
      body: { ref: 'main', inputs: { batch_id: payload.batch_id, commands_payload: JSON.stringify(payload) } },
    });
  }

  async runSync() {
    await this.request(`/repos/${this.repo}/actions/workflows/${SYNC_WORKFLOW}/dispatches`, {
      method: 'POST', what: 'start a sync', retries: 1, body: { ref: 'main' },
    });
  }

  /** The run whose title carries our batch id (run-name in the workflow). */
  async findRun(batchId, sinceIso) {
    const q = `?event=workflow_dispatch&per_page=20&created=%3E%3D${encodeURIComponent(sinceIso)}`;
    const data = await this.json(`/repos/${this.repo}/actions/workflows/${COMMANDS_WORKFLOW}/runs${q}`, { what: 'check the command workflow' });
    return (data.workflow_runs || []).find((r) => String(r.display_title || r.name || '').includes(batchId)) || null;
  }

  getRun(id) {
    return this.json(`/repos/${this.repo}/actions/runs/${Number(id)}`, { what: 'check the workflow run' });
  }

  async latestRun(workflow) {
    const data = await this.json(`/repos/${this.repo}/actions/workflows/${workflow}/runs?per_page=1`, { what: 'check recent runs' });
    return (data.workflow_runs || [])[0] || null;
  }
}
