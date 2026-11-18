/** Starts logged in: or/inventory.page.yml declares `auth: standard` for @inventory tests. */
import { test, expect } from '../fixtures';
import { step } from '@utils/steps';

test.describe('Inventory', { tag: '@inventory' }, () => {
  test('TC-INV-001 · add two products to cart', { tag: ['@positive', '@TC-INV-001', '@smoke'] }, async ({ inventoryPage, page }) => {
    await inventoryPage.open();
    await inventoryPage.addToCart('backpack');
    await inventoryPage.addToCart('t-shirt');
    await step.verify('Cart badge shows 2', async () => expect(await inventoryPage.el('cartBadge')).toHaveText('2'), page);
  });

  test('TC-INV-002 · cart badge hidden when cart is empty', { tag: ['@negative', '@TC-INV-002'] }, async ({ inventoryPage, page }) => {
    await inventoryPage.open();
    // negative check → strict(): primary locator only, never a fallback
    await step.verify('Cart badge is hidden', () => expect(inventoryPage.strict('cartBadge')).toBeHidden(), page);
  });

  test('TC-INV-003 · logout returns to login', { tag: ['@positive', '@TC-INV-003'] }, async ({ inventoryPage, loginPage }) => {
    await inventoryPage.open();
    await inventoryPage.logout();
    await loginPage.assertLoaded();
  });
});
