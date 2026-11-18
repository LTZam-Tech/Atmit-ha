import type { Page } from '@playwright/test';
import { BasePage } from '@pages/base.page';
import type { ORRegistry } from '../or/or.types.gen';
import { step } from '@utils/steps';

export class InventoryPage extends BasePage<ORRegistry, 'inventory'> {
  constructor(page: Page) {
    super(page, 'inventory');
  }

  async addToCart(sku: string): Promise<void> {
    await step.click(`Add "${sku}" to cart`, async () => (await this.el('addToCart', { sku })).click());
  }

  async logout(): Promise<void> {
    await step.click('Logout', async () => (await this.el('logout')).click());
  }
}
