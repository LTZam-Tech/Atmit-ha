/**
 * Thin API client for test-data setup/cleanup. Creating data through the API instead of
 * the UI is the biggest speed and stability win in a UI suite.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import { step } from './steps';

export class ApiClient {
  constructor(private readonly request: APIRequestContext) {}

  get(url: string, headers?: Record<string, string>) {
    return step.api(`GET ${url}`, () => this.request.get(url, { headers }));
  }

  post<T extends object>(url: string, data: T, headers?: Record<string, string>) {
    return step.api(`POST ${url}`, () => this.request.post(url, { data, headers }));
  }

  delete(url: string, headers?: Record<string, string>) {
    return step.api(`DELETE ${url}`, () => this.request.delete(url, { headers }));
  }

  /** Server is up when it answers below 500 (401/403 = up but protected, e.g. by a WAF) */
  async expectHealthy(url = '/') {
    const res = await this.get(url);
    expect(res.status(), `Environment health check ${url} returned ${res.status()}`).toBeLessThan(500);
  }
}
