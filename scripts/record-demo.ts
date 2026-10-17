/**
 * Records the README demo: two browser windows pinned to different server instances, editing one
 * board. Each context is recorded by Playwright (webm); ffmpeg then joins them side by side as a GIF.
 *
 *   docker compose --profile scale up -d --build --wait
 *   npm run demo:gif                       # BASE_URL defaults to http://localhost:8088
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import ffmpegPath from 'ffmpeg-static';

const BASE = process.env.BASE_URL ?? 'http://localhost:8088';
const OUT = path.resolve('docs');
const SIZE = { width: 900, height: 480 };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function signIn(browser: Browser, persona: string) {
  const ctx = await browser.newContext({ viewport: SIZE });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.getByRole('button', { name: persona }).click();
  await page.getByRole('heading', { name: 'Boards' }).waitFor();
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

async function glide(page: Page, x: number, y: number, steps = 18) {
  await page.mouse.move(x, y, { steps });
}

async function center(_page: Page, selector: ReturnType<Page['locator']>) {
  const box = (await selector.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function addCard(page: Page, column: string, title: string) {
  const lane = page.getByRole('region', { name: column });
  await lane.getByRole('button', { name: '+ Add card' }).click();
  await page.keyboard.type(title, { delay: 35 });
  await page.keyboard.press('Enter');
  await lane.getByRole('button', { name: 'Done', exact: true }).click();
}

async function main() {
  const browser = await chromium.launch();
  const tmp = mkdtempSync(path.join(tmpdir(), 'rb-demo-'));
  const adaState = await signIn(browser, 'Ada Lovelace');
  const graceState = await signIn(browser, 'Grace Hopper');

  // Create the board with Ada outside of the recording so the clip starts on the board itself.
  const setup = await browser.newContext({ viewport: SIZE, storageState: adaState });
  const sp = await setup.newPage();
  await sp.goto(`${BASE}/?node=1`);
  await sp.getByLabel('New board name').fill('Product launch');
  await sp.getByRole('button', { name: 'Create board' }).click();
  await sp.getByTestId('lanes').waitFor();
  const boardPath = new URL(sp.url()).pathname;
  await setup.close();

  const open = async (state: typeof adaState, node: 1 | 2): Promise<[BrowserContext, Page]> => {
    const ctx = await browser.newContext({
      viewport: SIZE,
      storageState: state,
      recordVideo: { dir: path.join(tmp, `node-${node}`), size: SIZE },
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/?node=${node}`); // pins this tab to a server instance (see apps/web/src/lib/node.ts)
    await page.evaluate((p) => history.pushState(null, '', p), boardPath);
    await page.reload();
    await page.getByTestId('lanes').waitFor();
    return [ctx, page];
  };

  const [ctxA, ada] = await open(adaState, 1);
  const [ctxB, grace] = await open(graceState, 2);
  await ada.getByText(/Live on server-1/).waitFor();
  await grace.getByText(/Live on server-2/).waitFor();
  await pause(1200);

  // 1. Ada adds a card; it appears on Grace's window (other instance).
  await addCard(ada, 'To do', 'Draft launch announcement');
  await pause(900);
  // 2. Grace adds one back.
  await addCard(grace, 'To do', 'Collect customer quotes');
  await pause(900);

  // 3. Cursors: both wander so each window shows the other's labelled cursor.
  await glide(ada, 640, 300);
  await glide(grace, 150, 250);
  await glide(ada, 420, 180, 24);
  await glide(grace, 330, 330, 24);
  await pause(600);

  // 4. Grace drags Ada's card into "In progress" - Ada sees it land.
  const card = grace.getByTestId('card').filter({ hasText: 'Draft launch announcement' });
  const from = await center(grace, card);
  const target = await center(grace, grace.getByTestId('cards-In progress'));
  await grace.mouse.move(from.x, from.y, { steps: 6 });
  await grace.mouse.down();
  await grace.mouse.move(from.x + 12, from.y + 8, { steps: 4 });
  await grace.mouse.move(target.x, target.y + 30, { steps: 25 });
  await grace.mouse.up();
  await pause(1200);

  // 5. Ada edits a card: Grace sees "Ada Lovelace is editing".
  await ada.getByTestId('card').filter({ hasText: 'Collect customer quotes' }).click();
  await ada.getByLabel('Description').focus();
  await ada.keyboard.type('Three short quotes, with permission.', { delay: 45 });
  await pause(1600);
  await ada.getByRole('button', { name: 'Done', exact: true }).click();
  await pause(1400);

  await ctxA.close();
  await ctxB.close();
  await browser.close();

  const videoOf = (n: number) => {
    const dir = path.join(tmp, `node-${n}`);
    return path.join(dir, readdirSync(dir).find((f) => f.endsWith('.webm'))!);
  };
  mkdirSync(OUT, { recursive: true });
  const gif = path.join(OUT, 'demo.gif');
  execFileSync(
    ffmpegPath!,
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      videoOf(1),
      '-i',
      videoOf(2),
      '-filter_complex',
      '[0:v][1:v]hstack=inputs=2,fps=10,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
      '-loop',
      '0',
      gif,
    ],
    { stdio: 'inherit' },
  );
  rmSync(tmp, { recursive: true, force: true });
  console.log(`Wrote ${gif} (${(statSync(gif).size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
