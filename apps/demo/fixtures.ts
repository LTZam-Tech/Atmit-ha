/** Demo app fixtures — adds the demo's Page Objects on top of the generic framework fixtures. */
import { test as base, expect } from '@fixtures';
import { LoginPage } from './pages/login.page';
import { InventoryPage } from './pages/inventory.page';

export const test = base.extend<{ loginPage: LoginPage; inventoryPage: InventoryPage }>({
  loginPage: async ({ page }, use) => use(new LoginPage(page)),
  inventoryPage: async ({ page }, use) => use(new InventoryPage(page)),
});

export { expect };
