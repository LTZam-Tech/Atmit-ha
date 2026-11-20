/**
 * Report branding profiles — branding/profiles.yml (one per client / delivery):
 *
 *   smartminds-moh:
 *     name: Smart Minds × MOH
 *     company: Smart Minds AI
 *     client: Ministry of Health
 *     primaryColor: "#0f6e5a"
 *     reportTitle: Mallafi — Automation Report
 *     footer: Prepared by the QA team
 *     confidentiality: Confidential
 *     logo: data:image/png;base64,...      # optional, set from the Control Panel
 *
 * A project picks its profile with `branding: <profile>` in apps/<app>/app.yml.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ROOT } from './app';

export interface BrandingProfile {
  name: string;
  company?: string;
  client?: string;
  primaryColor?: string;
  reportTitle?: string;
  footer?: string;
  confidentiality?: string;
  logo?: string;
}

export const BRANDING_FILE = path.join(ROOT, 'branding', 'profiles.yml');

const DEFAULT: Record<string, BrandingProfile> = {
  default: { name: 'Default', company: 'QA Team', primaryColor: '#2a78d6', reportTitle: 'Automation Smart Report' },
};

export function loadProfiles(): Record<string, BrandingProfile> {
  if (!fs.existsSync(BRANDING_FILE)) return { ...DEFAULT };
  const data = YAML.parse(fs.readFileSync(BRANDING_FILE, 'utf8')) ?? {};
  return Object.keys(data).length ? data : { ...DEFAULT };
}

export function saveProfiles(profiles: Record<string, BrandingProfile>) {
  for (const [k, p] of Object.entries(profiles)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(k)) throw new Error(`Profile key "${k}" must be lowercase letters, digits or "-"`);
    if (!p.name) throw new Error(`Profile "${k}" needs a name`);
    if (p.primaryColor && !/^#[0-9a-f]{6}$/i.test(p.primaryColor)) throw new Error(`Profile "${k}": color must look like #2a78d6`);
    if (p.logo && (!p.logo.startsWith('data:image/') || p.logo.length > 700_000)) throw new Error(`Profile "${k}": logo must be an image under ~500 KB`);
  }
  fs.mkdirSync(path.dirname(BRANDING_FILE), { recursive: true });
  fs.writeFileSync(BRANDING_FILE, '# Report branding profiles — edit in Control Panel → Settings → Branding\n' + YAML.stringify(profiles, { lineWidth: 0 }));
}

export function profileFor(key?: string): BrandingProfile {
  // a run started from the platform brings the project's profile with the job (agent/agent.ts)
  const fromJob = process.env.ATIMTHA_BRANDING_FILE;
  if (fromJob && fs.existsSync(fromJob)) {
    try {
      const p = JSON.parse(fs.readFileSync(fromJob, 'utf8')) as BrandingProfile;
      if (p?.name) return p;
    } catch { /* fall back to the local profiles */ }
  }
  const all = loadProfiles();
  return (key && all[key]) || all.default || Object.values(all)[0] || DEFAULT.default;
}
