import { expect, type Page } from '@playwright/test';

export async function signInAs(page: Page, origin: string, persona: string) {
  await page.goto(origin);
  await page.getByRole('button', { name: persona }).click();
  await expect(page.getByRole('heading', { name: 'Boards' })).toBeVisible();
}

export const card = (page: Page, title: string) => page.getByTestId('card').filter({ hasText: title });
export const cardsIn = (page: Page, column: string) => page.getByTestId(`cards-${column}`).getByTestId('card');

export async function addCard(page: Page, column: string, title: string) {
  const lane = page.getByRole('region', { name: column });
  await lane.getByRole('button', { name: '+ Add card' }).click();
  await lane.getByLabel('Card title').fill(title);
  await lane.getByLabel('Card title').press('Enter');
  await lane.locator('.add-card-form').getByRole('button', { name: 'Done', exact: true }).click();
}

/** Invites someone through the REST API as the signed-in user of `page`. */
export async function inviteViaApi(
  page: Page,
  origin: string,
  boardPath: string,
  email: string,
  role: 'editor' | 'viewer',
) {
  const token = await page.evaluate(
    () => (JSON.parse(localStorage.getItem('realtime-board.session') ?? 'null') as { token: string } | null)?.token,
  );
  const boardId = boardPath.split('/').at(-1);
  const res = await page.request.post(`${origin}/api/boards/${boardId}/members`, {
    headers: { authorization: `Bearer ${token}` },
    data: { email, role },
  });
  expect(res.ok()).toBe(true);
}
