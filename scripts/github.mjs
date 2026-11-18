// Git Credential Manager credentials stay in memory and are never logged or written.
import { execFileSync } from 'node:child_process';
const action = process.argv[2] || 'check';
let credentials;
try {
  credentials = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch {
  console.error('No non-interactive GitHub credentials available in Git Credential Manager.');
  process.exit(2);
}
const token = credentials
  .split('\n')
  .find((line) => line.startsWith('password='))
  ?.slice(9);
credentials = '';
if (!token) {
  console.error('No GitHub credential found.');
  process.exit(2);
}
async function api(path, method = 'GET', body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${data.message || res.statusText}`);
  return data;
}
try {
  const user = await api('/user');
  const repo = 'lectern-notes';
  const root = `/repos/${user.login}/${repo}`;
  if (action === 'check') console.log(JSON.stringify({ login: user.login, authenticated: true }));
  else if (action === 'create') {
    const created = await api('/user/repos', 'POST', {
      name: repo,
      description:
        'iPad-ready PDF lecture workspace: Pencil notes, inline YouTube, and laser pointer.',
      private: false,
      auto_init: false,
    });
    console.log(JSON.stringify({ repository: created.full_name, url: created.html_url }));
  } else if (action === 'pages') {
    const pages = await api(`${root}/pages`, 'POST', { build_type: 'workflow' });
    console.log(JSON.stringify({ url: pages.html_url, status: pages.status }));
  } else if (action === 'status') {
    const runs = await api(`${root}/actions/runs?per_page=3`);
    console.log(
      JSON.stringify(
        runs.workflow_runs.map((r) => ({
          id: r.id,
          status: r.status,
          conclusion: r.conclusion,
          url: r.html_url,
          sha: r.head_sha,
        })),
      ),
    );
  } else if (action === 'logs') {
    const runs = await api(`${root}/actions/runs?per_page=1`);
    const jobs = await api(`${root}/actions/runs/${runs.workflow_runs[0].id}/jobs`);
    console.log(
      JSON.stringify(
        jobs.jobs.map((j) => ({
          name: j.name,
          status: j.status,
          conclusion: j.conclusion,
          steps: j.steps,
        })),
      ),
    );
  } else throw new Error('Unknown action');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
