/**
 * Signed execution packages (backlog §10/§13): the platform signs every job it hands out (ES256 over the exact
 * response bytes, header "X-Atimtha-Signature: <keyId>.<base64 r||s>"); the agent verifies before it runs anything.
 *
 *   ATIMTHA_JOB_KEY            optional pinned public key: PEM text or a path to a .pem file. When set, the agent
 *                              trusts only this key, whatever the platform publishes.
 *   ATIMTHA_REQUIRE_SIGNED_JOBS  "false" accepts unsigned jobs (old platforms, local experiments). Default: required.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const SIGNATURE_HEADER = 'x-atimtha-signature';

export interface TrustedKey { keyId: string; key: crypto.KeyObject; pinned: boolean }

/** keyId as the platform computes it: first 16 hex characters of SHA-256 over the SubjectPublicKeyInfo (DER) */
export function keyIdOf(key: crypto.KeyObject): string {
  return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

export function publicKeyFrom(pemOrPath: string): crypto.KeyObject {
  const pem = pemOrPath.includes('BEGIN PUBLIC KEY') ? pemOrPath : fs.readFileSync(pemOrPath, 'utf8');
  const key = crypto.createPublicKey(pem.replace(/\\n/g, '\n'));
  if (key.asymmetricKeyType !== 'ec') throw new Error('ATIMTHA_JOB_KEY must be an ECDSA P-256 public key');
  return key;
}

/** the key jobs must be signed with: the pinned one, else the one the platform publishes (it must match a pin) */
export function trustedKey(published: { keyId: string; publicKeyPem: string } | undefined, pinned = process.env.ATIMTHA_JOB_KEY): TrustedKey | undefined {
  if (pinned) {
    const key = publicKeyFrom(pinned);
    const keyId = keyIdOf(key);
    if (published && published.keyId !== keyId) throw new Error(`the platform signs with key ${published.keyId}, but this agent trusts only ${keyId} (ATIMTHA_JOB_KEY)`);
    return { keyId, key, pinned: true };
  }
  if (!published) return undefined;
  const key = crypto.createPublicKey(published.publicKeyPem);
  if (keyIdOf(key) !== published.keyId) throw new Error('the platform published a signing key that does not match its key id');
  return { keyId: published.keyId, key, pinned: false };
}

/** null = valid; otherwise why the job must not run */
export function verifyJob(body: string, header: string | null, trusted: TrustedKey | undefined, required = process.env.ATIMTHA_REQUIRE_SIGNED_JOBS !== 'false'): string | null {
  if (!header) return required ? 'the job is not signed' : null;
  if (!trusted) return required ? 'no signing key to verify the job with' : null;
  const dot = header.indexOf('.');
  if (dot <= 0) return 'malformed job signature';
  const keyId = header.slice(0, dot);
  if (keyId !== trusted.keyId) return `the job is signed with key ${keyId}, not the trusted key ${trusted.keyId}`;
  const ok = crypto.verify('sha256', Buffer.from(body, 'utf8'), { key: trusted.key, dsaEncoding: 'ieee-p1363' }, Buffer.from(header.slice(dot + 1), 'base64'));
  return ok ? null : 'the job signature is not valid';
}
