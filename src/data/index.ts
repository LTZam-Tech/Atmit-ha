import type { Faker } from '@faker-js/faker';
import { appConfig, environment } from '../../config/environment';
import { LoginBuilder } from './builders/login.builder';

/** Expected UI message from apps/<app>/messages.yml in the current run language */
export const msg = (key: string): string => {
  const value = appConfig.messages[environment.locale]?.[key] ?? appConfig.messages.en?.[key];
  if (value === undefined) throw new Error(`[data] Message "${key}" not found in apps/${appConfig.key}/messages.yml`);
  return value;
};

/** Entry point for all data builders — injected into tests as the `data` fixture */
export class DataFactory {
  constructor(readonly faker: Faker, readonly seed: number) {}

  get login() {
    return new LoginBuilder(this.faker);
  }
}

export { Negative, boundary } from './negative/values';
export type { LoginData } from './builders/login.builder';
