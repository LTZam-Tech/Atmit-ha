/**
 * "Export" jobs (backlog §3/§6): the project the job carries becomes a standalone Playwright + TypeScript project
 * (src/core/export/codegen.ts, the same generator as the local panel). The files travel to the platform as one JSON
 * run file, playwright-project.json = { files: { path: text }, warnings }; the platform serves it as a ZIP.
 */
import { generateProject } from '../src/core/export/codegen';

export interface ExportResult { files: Record<string, string>; warnings: string[] }

export function exportProject(appKey: string): ExportResult {
  const { files, warnings } = generateProject(appKey);
  return { files: Object.fromEntries(files), warnings };
}
