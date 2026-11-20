import { expect, test, type Page, type Route } from '@playwright/test';
import JSZip from 'jszip';
import { blankPage, type Project } from '../src/model';

const signature = 'LECTERN/1\n';
const folder = { id: 'teaching', name: '講義', folder: {} };
const root = { id: 'root', name: 'root', folder: {}, parentReference: { driveId: 'drive' } };
const name = '第3回講義.lectern';
const filename = 'project.json';
const downloadUrl = 'https://files.example.org/download';
const uploadUrl = 'https://files.example.org/upload';

async function remoteProject() {
  const p: Project = {
    id: 'onedrive-test-project',
    name: '第3回講義',
    createdAt: 100,
    updatedAt: 100,
    pages: [blankPage()],
    currentPage: 0,
  };
  const zip = new JSZip();
  zip.file(filename, JSON.stringify({ format: 'lectern-project', version: 1, project: p }));
  return Buffer.concat([Buffer.from(signature), await zip.generateAsync({ type: 'nodebuffer' })]);
}

async function mockOneDrive(page: Page) {
  const state = { body: await remoteProject(), revision: 1, uploads: 0, online: true };
  const eTag = () => `"r${state.revision}"`;
  const item = () => ({
    id: 'lesson',
    name,
    file: {},
    eTag: eTag(),
    size: state.body.length,
    '@microsoft.graph.downloadUrl': downloadUrl,
  });
  await page.route('**/src/useOneDriveAuth.ts*', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `
        import { createOneDriveClient } from '/src/oneDrive.ts';
        const accountId = 'faculty/test';
        const client = createOneDriveClient(async () => 'test-token', async (url, init) => {
          // Playwright's WebKit route interceptor cannot read a Blob request body.
          const body = init?.body instanceof Blob ? await init.body.arrayBuffer() : init?.body;
          return fetch(url, { ...init, body });
        });
        const getClient = async () => ({ accountId, client });
        export function useOneDriveAuth() {
          return { configured: true, ready: true, account: { id: accountId, label: 'Faculty' },
            error: '', signIn: async () => {}, signOut: async () => {}, getClient };
        }
      `,
    }),
  );
  await page.route('https://graph.microsoft.com/**', (route) => {
    const req = route.request();
    expect(req.headers().authorization).toBe('Bearer test-token');
    if (!state.online) return route.abort('internetdisconnected');
    switch (new URL(req.url()).pathname) {
      case '/v1.0/me/drive/root':
        return route.fulfill({ json: root });
      case '/v1.0/drives/drive/items/root/children':
        return route.fulfill({ json: { value: [folder] } });
      case '/v1.0/drives/drive/items/teaching/children':
        return route.fulfill({ json: { value: [item()] } });
      case '/v1.0/drives/drive/items/lesson':
        return route.fulfill({ json: item() });
      case '/v1.0/drives/drive/items/lesson/createUploadSession':
        expect(req.method()).toBe('POST');
        return req.headers()['if-match'] === eTag()
          ? route.fulfill({ json: { uploadUrl } })
          : route.fulfill({ status: 412, json: {} });
      default:
        return route.fulfill({ status: 404, json: {} });
    }
  });
  await page.route(downloadUrl, (route) =>
    route.fulfill({ contentType: 'application/octet-stream', body: state.body }),
  );
  await page.route(uploadUrl, (route: Route) => {
    const req = route.request();
    expect(req.method()).toBe('PUT');
    expect(req.headers().authorization).toBeUndefined();
    const body = req.postDataBuffer()!;
    expect(req.headers()['content-range']).toBe(`bytes 0-${body.length - 1}/${body.length}`);
    state.body = body;
    state.revision++;
    state.uploads++;
    return route.fulfill({ json: item() });
  });
  return state;
}

async function openFromOneDrive(page: Page) {
  await page.getByRole('button', { name: 'OneDriveから開く' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('button', { name: '講義', exact: true }).click();
  await picker.getByRole('button', { name, exact: true }).click();
}

async function draw(page: Page, y: number) {
  const paper = page.getByTestId('pdf-page');
  await expect(paper).toBeVisible();
  const box = (await paper.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * y + 10, { steps: 8 });
  await page.mouse.up();
}

async function containedProject(bytes: Buffer) {
  expect(bytes.subarray(0, signature.length).toString()).toBe(signature);
  const zip = await JSZip.loadAsync(bytes.subarray(signature.length));
  return (JSON.parse(await zip.file(filename)!.async('string')) as { project: Project }).project;
}

test('keeps a OneDrive target after reload, saves to the same file and protects a newer revision', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const state = await mockOneDrive(page);
  await page.goto('/');
  await openFromOneDrive(page);
  const save = page.getByRole('button', { name: 'プロジェクトを保存', exact: true });
  await expect(save).toHaveAttribute('title', `OneDriveの「${name}」に保存`);
  await page.reload();
  await expect(save).toHaveAttribute('title', `OneDriveの「${name}」に保存`);
  await draw(page, 0.4);
  await save.click();
  await expect(page.locator('.project-file-notice')).toContainText('OneDrive');
  expect(state.uploads).toBe(1);
  const first = await containedProject(state.body);
  expect(first.id).toBe('onedrive-test-project');
  expect(first.pages[0].strokes).toHaveLength(1);

  await draw(page, 0.6);
  state.revision++;
  await save.click();
  await expect(page.getByRole('alert')).toContainText('OneDrive上のファイルが更新されています');
  expect(state.uploads).toBe(1);
  await page.getByRole('button', { name: 'エラーを閉じる' }).click();
  await page.getByRole('button', { name: 'ライブラリに戻る' }).click();
  await openFromOneDrive(page);
  await page.getByRole('dialog').getByRole('button', { name: 'この端末の編集を使う' }).click();
  await expect(save).toHaveAttribute('title', `OneDriveの「${name}」に保存`);

  state.online = false;
  await save.click();
  await expect(page.getByRole('alert')).toContainText('ネットワーク');
  expect(state.uploads).toBe(1);
  state.online = true;
  await save.click();
  await expect(page.locator('.project-file-notice')).toContainText('OneDrive');
  const edited = await containedProject(state.body);
  expect(state.uploads).toBe(2);
  expect(edited.pages[0].strokes).toHaveLength(2);
  expect(edited.pages[0].strokes[0]).toEqual(first.pages[0].strokes[0]);
});
