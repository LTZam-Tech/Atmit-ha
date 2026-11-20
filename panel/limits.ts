/**
 * Input limits for the Control Panel (threat model T4–T7).
 *
 *   T5  request bodies have a size limit         → readLimitedBody / BODY_LIMITS
 *   T6  request values passed to child processes cannot be read as options → safeArg
 *   T7  static files are served only from inside their folder              → isInside
 *   T4  project zips have size and entry limits, no paths outside the project → checkZip
 */
import path from 'node:path';
import type http from 'node:http';

/** an error that carries the HTTP status the panel answers with */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const MB = 1024 * 1024;

/** bytes a request body may have: imports carry a base64 zip, everything else is small JSON */
export const BODY_LIMITS = { default: 2 * MB, import: 70 * MB } as const;

/** read a JSON body, refusing it once it passes `limit` bytes (413) or when it is not valid JSON (400) */
export function readLimitedBody(req: http.IncomingMessage, limit: number = BODY_LIMITS.default): Promise<any> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      return reject(new HttpError(413, `Request too large (${Math.ceil(declared / MB)} MB, limit ${Math.floor(limit / MB)} MB)`));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (d: Buffer) => {
      if (failed) return;
      size += d.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, `Request too large (limit ${Math.floor(limit / MB)} MB)`));
        req.resume();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new HttpError(400, 'The request body is not valid JSON')); }
    });
    req.on('error', (e) => { if (!failed) { failed = true; reject(e); } });
  });
}

/**
 * A request value used as a command-line argument of a child process. Values starting with "-" would be
 * read as options by the script (for example "--auth admin" or "--start https://elsewhere"), so they are
 * refused; control characters and very long values are refused too.
 */
export function safeArg(value: unknown, field: string, maxLength = 2000): string {
  const v = String(value ?? '');
  if (v.startsWith('-')) throw new HttpError(400, `${field} must not start with "-"`);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new HttpError(400, `${field} contains control characters`);
  if (v.length > maxLength) throw new HttpError(400, `${field} is too long (max ${maxLength} characters)`);
  return v;
}

/** is `file` inside `base`? Compares whole path segments, so "reports/smart-report-x" is not inside "reports/smart-report" */
export function isInside(base: string, file: string): boolean {
  const b = path.resolve(base);
  const f = path.resolve(file);
  const rel = path.relative(b, f);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** what checkZip needs to know about each archive entry (adm-zip's entries fit this shape) */
export interface ZipEntryInfo {
  entryName: string;
  isDirectory: boolean;
  header: { size: number; compressedSize: number };
}

export const ZIP_LIMITS = {
  /** compressed archive size */
  archiveBytes: 50 * MB,
  /** files in the archive */
  entries: 5000,
  /** total size once extracted */
  totalBytes: 200 * MB,
  /** one file once extracted */
  fileBytes: 50 * MB,
  /** extracted ÷ compressed for one file above this = a zip bomb */
  ratio: 200,
} as const;

/** refuse archives that are too big, hold too many files, expand too much, or point outside the project folder */
export function checkZip(archiveBytes: number, entries: ZipEntryInfo[], projectKey: string): void {
  const L = ZIP_LIMITS;
  if (archiveBytes > L.archiveBytes) throw new HttpError(413, `The zip is too large (limit ${L.archiveBytes / MB} MB)`);
  const files = entries.filter((e) => !e.isDirectory);
  if (files.length > L.entries) throw new HttpError(400, `The zip has too many files (${files.length}, limit ${L.entries})`);
  let total = 0;
  for (const e of files) {
    const name = e.entryName.replace(/\\/g, '/');
    if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) {
      throw new HttpError(400, `The zip contains an unsafe path: ${e.entryName}`);
    }
    if (!name.startsWith(`${projectKey}/`)) throw new HttpError(400, `The zip contains a file outside the project folder: ${e.entryName}`);
    const { size, compressedSize } = e.header;
    if (size > L.fileBytes) throw new HttpError(400, `${e.entryName} is too large once extracted`);
    if (compressedSize > 0 && size / compressedSize > L.ratio && size > MB) throw new HttpError(400, `${e.entryName} expands too much (zip bomb?)`);
    total += size;
    if (total > L.totalBytes) throw new HttpError(400, `The zip expands to more than ${L.totalBytes / MB} MB`);
  }
}
