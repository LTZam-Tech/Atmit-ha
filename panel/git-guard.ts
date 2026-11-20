/**
 * Commit policy for the Control Panel's Git button (backlog §14 "Improve Git commit controls and
 * secret-file protection"; ADR-0004).
 *
 * 0.1.0 ran `git add -A`, so every untracked file in the workspace was committed and only three
 * file-name patterns were blocked. Now:
 *   • the panel commits PROJECT CONTENT only — apps/ and branding/, what testers create in the panel;
 *     code and configuration changes are listed but left to the engineers' own Git client;
 *   • files are staged by explicit path, never with -A;
 *   • every project file is checked by name AND content; one suspicious file blocks the whole commit,
 *     so nothing is half-committed and the tester sees why.
 */

export interface GitChange {
  /** two-letter porcelain status, e.g. "??", " M", "D " */
  status: string;
  file: string;
  /** set for renames and copies: the old path */
  from?: string;
}

export interface CommitPlan {
  commit: GitChange[];
  /** not committed by the panel, commit continues */
  skipped: { change: GitChange; reason: string }[];
  /** stops the commit */
  blocked: { change: GitChange; reason: string }[];
}

/** folders the panel may commit */
export const COMMIT_AREAS = ['apps/', 'branding/'];

const SECRET_PATHS: RegExp[] = [
  /(^|\/)secrets\.ya?ml$/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.auth\//i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)credentials(\.json)?$/i,
];

const norm = (file: string) => file.replace(/\\/g, '/');

/** a file that must never be committed, whatever it contains */
export const isSecretPath = (file: string) => SECRET_PATHS.some((re) => re.test(norm(file)));

const SECRET_CONTENT: { name: string; re: RegExp }[] = [
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'cloud browser key', re: /\b(?:BROWSERSTACK_ACCESS_KEY|LT_ACCESS_KEY)\s*[:=]\s*['"]?[A-Za-z0-9]{12,}/ },
];

/** `password:` and similar keys holding a literal value — checked in app.yml, where users are defined */
const LITERAL_SECRET_FIELD = /^[ \t]*-?[ \t]*["']?(password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?[ \t]*:[ \t]*([^\n#]*)/gim;

const isPlaceholder = (value: string) => {
  const v = value.trim().replace(/^['"]|['"]$/g, '').trim();
  return !v || v === '~' || /^null$/i.test(v) || /^\{\{.*\}\}$/.test(v) || /^\$\{\w+\}$/.test(v);
};

/**
 * Reasons this file looks like it holds a credential (empty = clean).
 * `known` = the real passwords from the projects' secrets.yml files: finding one anywhere is a leak.
 */
export function findSecrets(file: string, text: string, known: string[] = []): string[] {
  const found = new Set<string>();
  for (const { name, re } of SECRET_CONTENT) if (re.test(text)) found.add(name);
  if (known.some((k) => k.length >= 4 && text.includes(k))) found.add('a password from secrets.yml');
  if (/(^|\/)app\.ya?ml$/i.test(norm(file))) {
    for (const m of text.matchAll(LITERAL_SECRET_FIELD)) {
      if (!isPlaceholder(m[2])) found.add(`literal ${m[1].toLowerCase()} in app.yml`);
    }
  }
  return [...found];
}

/** `git status --porcelain=v1 -z -uall` output → changes (handles spaces, quotes and renames) */
export function parsePorcelainZ(out: string): GitChange[] {
  const parts = out.split('\0');
  const changes: GitChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status[0] === 'R' || status[0] === 'C') {
      changes.push({ status, file, from: parts[i + 1] });
      i++;
    } else {
      changes.push({ status, file });
    }
  }
  return changes;
}

export const inCommitArea = (file: string) => COMMIT_AREAS.some((a) => norm(file).startsWith(a));

/**
 * Decide what the panel commits. `readText` returns a file's text (undefined when deleted or
 * unreadable), so the policy is testable without a repository.
 */
export function planCommit(changes: GitChange[], readText: (file: string) => string | undefined, known: string[] = []): CommitPlan {
  const plan: CommitPlan = { commit: [], skipped: [], blocked: [] };
  for (const change of changes) {
    if (!inCommitArea(change.file) || (change.from && !inCommitArea(change.from))) {
      plan.skipped.push({ change, reason: 'outside project files (apps/, branding/): commit it with your Git client' });
      continue;
    }
    if (isSecretPath(change.file)) {
      plan.blocked.push({ change, reason: 'secret file: never committed (check .gitignore)' });
      continue;
    }
    const text = change.status.includes('D') ? undefined : readText(change.file);
    const secrets = text ? findSecrets(change.file, text, known) : [];
    if (secrets.length) {
      plan.blocked.push({ change, reason: `${secrets.join(', ')}: move it to secrets.yml or a \${ENV_VAR}` });
      continue;
    }
    plan.commit.push(change);
  }
  return plan;
}
