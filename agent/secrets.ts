/**
 * Resolves the job's secret references (ADR-0014: secrets never travel in the job).
 *
 * Supported reference forms:
 *   vault:env/<NAME>       the agent's own environment variable NAME (set by the agent's operator)
 *   vault:file/<name>      a file in ATIMTHA_SECRETS_DIR (e.g. a mounted Kubernetes / Docker secret)
 * A secrets-manager client (HashiCorp Vault, Azure Key Vault…) plugs in here as another prefix.
 * Unresolved references are reported by path, never by value.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ResolvedSecrets {
  /** secrets.yml content for the materialised project */
  secrets: { users: Record<string, { password: string }>; environments?: Record<string, { httpCredentials: { password: string } }> };
  missing: string[];
}

export function resolveSecret(ref: string): string | undefined {
  const env = /^vault:env\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref);
  if (env) return process.env[env[1]];
  const file = /^vault:file\/([A-Za-z0-9._-]+)$/.exec(ref);
  if (file) {
    const dir = process.env.ATIMTHA_SECRETS_DIR;
    if (!dir) return undefined;
    const p = path.join(dir, file[1]);
    if (!path.resolve(p).startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(p)) return undefined;
    return fs.readFileSync(p, 'utf8').trim();
  }
  return undefined;
}

/** secretRefs: "users.<key>.password" | "environments.<key>.httpCredentials.password" → reference */
export function resolveSecrets(secretRefs: Record<string, string> = {}): ResolvedSecrets {
  const out: ResolvedSecrets = { secrets: { users: {} }, missing: [] };
  for (const [where, ref] of Object.entries(secretRefs)) {
    const value = resolveSecret(ref);
    if (value === undefined) { out.missing.push(where); continue; }
    const user = /^users\.([\w-]+)\.password$/.exec(where);
    const env = /^environments\.([\w-]+)\.httpCredentials\.password$/.exec(where);
    if (user) out.secrets.users[user[1]] = { password: value };
    else if (env) (out.secrets.environments ??= {})[env[1]] = { httpCredentials: { password: value } };
    else out.missing.push(where);
  }
  return out;
}
