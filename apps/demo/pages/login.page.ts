import type { Page } from '@playwright/test';
import { BasePage } from '@pages/base.page';
import type { ORRegistry } from '../or/or.types.gen';
import { step, mask } from '@utils/steps';
import type { LoginData } from '@data/index';

export class LoginPage extends BasePage<ORRegistry, 'login'> {
  constructor(page: Page) {
    super(page, 'login');
  }

  async fillCredentials({ username, password }: LoginData): Promise<void> {
    await step.enter(`Username = "${username || '(empty)'}"`, async () => (await this.el('username')).fill(username));
    await step.enter(`Password = ${mask(password)}`, async () => (await this.el('password')).fill(password));
  }

  async submit(): Promise<void> {
    await step.click('Login button', async () => (await this.el('submit')).click());
  }

  /** Navigate → Data entry → Click — the shared flow for positive AND negative scenarios */
  async login(data: LoginData): Promise<void> {
    await this.fillCredentials(data);
    await this.submit();
  }

  async errorText(): Promise<string> {
    return (await (await this.el('errorMessage')).textContent())?.trim() ?? '';
  }
}
