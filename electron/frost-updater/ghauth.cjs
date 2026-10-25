// The GitHub sign-in for the updater's git commands (clone, fetch, pull). The suite's repositories are
// private and the updater runs with no window to type into, so git's own helper (Git Credential Manager)
// can't ask. The GitHub CLI's login is used for that one command: `gh auth token`, handed to git through
// GIT_CONFIG_* environment entries with every other helper switched off for it. The owner's git config is
// not changed and the token is never stored or logged. (An app can pass its own `auth` instead: Frost AI
// uses its GitHub CLI wrapper.)
const { execFile } = require('child_process');

const TOKEN_ENV = 'FROST_UPDATER_GH_TOKEN';

/** The environment that gives git `token` for github.com, and nothing else. */
function gitEnv(token, base = process.env) {
  const env = { ...base };
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  const add = (i, k, v) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  };
  add(n, 'credential.helper', '');
  add(n + 1, 'credential.helper', `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$${TOKEN_ENV}"; }; f`);
  env.GIT_CONFIG_COUNT = String(n + 2);
  env[TOKEN_ENV] = token || '';
  env.GIT_TERMINAL_PROMPT = '0'; // never wait for a typed password
  env.GCM_INTERACTIVE = 'never';
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  return env;
}

const gh = (args) =>
  new Promise((resolve) => {
    execFile('gh', args, { windowsHide: true, timeout: 15_000 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`, stdout: String(stdout || '').trim() }));
  });

/** { env, login }: login '' when the GitHub CLI isn't installed or signed in (git then runs with prompts off). */
async function githubAuth(run = gh) {
  const plain = { env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, login: '' };
  const status = await run(['auth', 'status', '--hostname', 'github.com']);
  const login = (/account (\S+)/.exec(status.out) || [])[1] || '';
  if (!login) return plain;
  const token = await run(['auth', 'token', '--hostname', 'github.com']);
  if (!token.ok || !token.stdout) return plain;
  return { env: gitEnv(token.stdout, {}), login };
}

module.exports = { githubAuth, gitEnv, TOKEN_ENV };
