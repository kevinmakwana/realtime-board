import { expect, test } from '@playwright/test';
import { E2E } from '../playwright.config';
import { signInAs } from './helpers';

test('an owner invites through the Share dialog, a viewer cannot edit, and removal ends access live', async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ada = await ctxA.newPage();
  const grace = await ctxB.newPage();

  await signInAs(ada, E2E.webA, 'Ada Lovelace');
  await ada.getByLabel('New board name').fill(`Shared ${Date.now()}`);
  await ada.getByRole('button', { name: 'Create board' }).click();
  await expect(ada.getByTestId('lanes')).toBeVisible();
  const path = new URL(ada.url()).pathname;

  await test.step('a stranger cannot open the board', async () => {
    await signInAs(grace, E2E.webB, 'Grace Hopper');
    await grace.goto(`${E2E.webB}${path}`);
    await expect(grace.getByTestId('no-access')).toBeVisible();
  });

  await test.step('Ada invites Grace as a viewer from the Share dialog', async () => {
    await ada.getByTestId('share').click();
    const dialog = ada.getByRole('dialog', { name: 'Share board' });
    await dialog.getByLabel('Invite by email').fill('grace@example.test');
    await dialog.getByLabel('Invite role').selectOption('viewer');
    await dialog.getByRole('button', { name: 'Invite' }).click();
    await expect(dialog.getByTestId('member')).toHaveCount(2);
    await ada.keyboard.press('Escape');
  });

  await test.step('Grace sees the board read-only', async () => {
    await grace.goto(`${E2E.webB}${path}`);
    await expect(grace.getByTestId('lanes')).toBeVisible();
    await expect(grace.getByRole('button', { name: '+ Add card' })).toHaveCount(0);
    await expect(grace.getByRole('button', { name: '+ Add column' })).toHaveCount(0);
  });

  await test.step('Ada upgrades her to editor and the controls appear without a reload', async () => {
    await ada.getByTestId('share').click();
    await ada.getByRole('dialog', { name: 'Share board' }).getByLabel('Role for Grace Hopper').selectOption('editor');
    await ada.keyboard.press('Escape');
    await expect(grace.getByRole('button', { name: '+ Add card' }).first()).toBeVisible();
  });

  await test.step('Ada removes Grace and she is cut off immediately', async () => {
    await ada.getByTestId('share').click();
    await ada.getByRole('dialog', { name: 'Share board' }).getByRole('button', { name: 'Remove Grace Hopper' }).click();
    await expect(grace.getByTestId('no-access')).toBeVisible();
  });

  await ctxA.close();
  await ctxB.close();
});
