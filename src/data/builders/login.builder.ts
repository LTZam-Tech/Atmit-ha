/**
 * Login data builder — one source for positive AND negative data.
 * Users come from apps/<app>/app.yml (+ secrets.yml).
 *
 *   data.login.valid().build()
 *   data.login.user('admin').build()
 *   data.login.valid().with({ password: '' }).build()
 *   data.login.wrongPassword().build()
 */
import type { Faker } from '@faker-js/faker';
import { appConfig } from '../../../config/environment';
import { Negative } from '../negative/values';

export interface LoginData {
  username: string;
  password: string;
}

export class LoginBuilder {
  private data: LoginData = { username: '', password: '' };

  constructor(private readonly faker: Faker) {}

  user(key = 'standard'): this {
    const u = appConfig.users[key];
    if (!u) throw new Error(`[data] User "${key}" not defined in apps/${appConfig.key}/app.yml. Users: ${Object.keys(appConfig.users).join(', ') || '(none)'}`);
    this.data = { username: u.username, password: u.password ?? '' };
    return this;
  }

  /** First user in app.yml (or "standard") */
  valid(): this {
    return this.user(appConfig.users.standard ? 'standard' : Object.keys(appConfig.users)[0]);
  }

  lockedOut(): this {
    return this.user('locked');
  }

  wrongPassword(): this {
    this.valid();
    this.data.password = this.faker.internet.password({ length: 12 });
    return this;
  }

  unknownUser(): this {
    this.data = {
      username: this.faker.internet.username().toLowerCase(),
      password: this.faker.internet.password({ length: 10 }),
    };
    return this;
  }

  emptyUsername(): this {
    this.valid();
    this.data.username = Negative.empty;
    return this;
  }

  emptyPassword(): this {
    this.valid();
    this.data.password = Negative.empty;
    return this;
  }

  with(overrides: Partial<LoginData>): this {
    this.data = { ...this.data, ...overrides };
    return this;
  }

  build(): LoginData {
    return { ...this.data };
  }
}
