import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:5173/');
await page.getByRole('heading', { name: '講義を、ひとつの画面に。' }).waitFor();
await page.screenshot({ path: 'artifacts/library.png' });
await page.getByRole('button', { name: 'まずは3ページのサンプルで試す' }).click();
await page.getByTestId('pdf-page').waitFor();
await page.getByText('ページを読み込み中…', { exact: true }).waitFor({ state: 'hidden' });
await page.screenshot({ path: 'artifacts/editor.png' });
if (process.argv.includes('--ink')) {
  const r = await page.getByTestId('pdf-page').boundingBox();
  await page.getByLabel('ペンの太さ').selectOption('4');
  await page.mouse.move(r.x + r.width * 0.18, r.y + r.height * 0.42);
  await page.mouse.down();
  for (let i = 0; i <= 110; i++) {
    const t = i / 110;
    await page.mouse.move(
      r.x + r.width * (0.18 + 0.62 * t),
      r.y + r.height * 0.42 + Math.sin(t * Math.PI * 6) * 22,
    );
  }
  await page.mouse.up();
  await page.screenshot({ path: 'artifacts/smooth-ink.png' });
  await page.getByRole('button', { name: 'レーザー', exact: true }).click();
  await page.mouse.move(r.x + r.width * 0.2, r.y + r.height * 0.7);
  await page.mouse.down();
  for (let i = 0; i <= 32; i++) {
    const t = i / 32;
    await page.mouse.move(
      r.x + r.width * (0.2 + 0.6 * t),
      r.y + r.height * 0.7 + Math.sin(t * Math.PI * 2) * 26,
    );
  }
  await page.screenshot({ path: 'artifacts/smooth-laser.png' });
  await page.mouse.up();
}
if (process.argv.includes('--youtube')) {
  await page.getByRole('button', { name: 'YouTube挿入' }).click();
  await page.getByLabel('YouTube URL').fill('https://youtu.be/M7lc1UVf-VE');
  await page.getByRole('button', { name: 'このページに追加' }).click();
  await page.getByRole('button', { name: '動画をページ内で再生' }).click();
  const result = await Promise.race([
    page
      .getByTitle('YouTube動画', { exact: true })
      .waitFor()
      .then(() => 'real YouTube player ready'),
    page
      .locator('.video-error')
      .waitFor({ timeout: 35000 })
      .then(() => page.locator('.video-error').innerText()),
  ]);
  console.log(result);
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid="video-box"]')?.getAttribute('data-player-state') ===
        '1',
      null,
      { timeout: 15000 },
    )
    .catch(() => {});
  console.log(
    'Player state:',
    await page.getByTestId('video-box').getAttribute('data-player-state'),
    'Error:',
    await page.locator('.video-error').allTextContents(),
  );
  await page.screenshot({ path: 'artifacts/youtube.png' });
}
await browser.close();
