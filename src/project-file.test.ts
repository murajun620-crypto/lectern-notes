import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { blankPage, type Project } from './model';
import { exportBackup, exportProjectFile, openProjectFile, prepareProjectFile } from './storage';

const { projects, assets } = vi.hoisted(() => ({
  projects: new Map<string, Project>(),
  assets: new Map<string, ArrayBuffer>(),
}));
vi.mock('idb', () => ({
  openDB: async () => ({
    get: (store: string, id: string) => (store === 'assets' ? assets : projects).get(id),
    getKey: (_store: string, id: string) => (assets.has(id) ? id : undefined),
  }),
}));

describe('editable Lectern project files', () => {
  const header = 'LECTERN/1\n';
  const original = new TextEncoder().encode('%PDF-1.7 identical source').buffer;
  let project: Project;
  beforeEach(() => {
    projects.clear();
    assets.clear();
    project = {
      id: 'existing-project',
      name: '資料',
      createdAt: 0,
      updatedAt: 1,
      currentPage: 0,
      pages: ['original', 'appended'].map((assetId) => ({
        ...blankPage(),
        assetId,
        sourcePage: 1,
      })),
    };
    projects.set(project.id, project);
    for (const pg of project.pages) assets.set(pg.assetId!, original);
  });

  it('recognizes its own unchanged file with two references to identical PDFs', async () => {
    const blob = await exportProjectFile(project);
    expect(await blob.slice(0, header.length).text()).toBe(header);
    const prepared = await prepareProjectFile(new File([blob], '資料.lectern'));
    expect(prepared.conflict).toBe(false);
    expect(prepared.project).toEqual(project);
    expect(prepared.assets.size).toBe(0);
  });

  it('preserves inserted paper patterns when a project file is opened on a new device', async () => {
    const sheets = [blankPage(720, 410, 'lined'), blankPage(360, 640, 'grid')];
    project.pages.push(...sheets);
    const blob = await exportProjectFile(project);
    projects.clear();
    assets.clear();

    const prepared = await prepareProjectFile(new File([blob], '資料.lectern'));
    expect(prepared.project.pages.slice(-2)).toEqual(sheets);
  });

  it('compares the actual PDF even if the embedded source ID matches a local PDF', async () => {
    const file = await exportProjectFile(project);
    const zip = await JSZip.loadAsync(await file.slice(header.length).arrayBuffer());
    zip.file('assets/original.pdf', '%PDF-1.7 different source');
    const body = await zip.generateAsync({ type: 'arraybuffer' });
    const prepared = await prepareProjectFile(new File([header, body], '資料.lectern'));
    expect(prepared.conflict).toBe(true);
    expect(prepared.project.pages[0].assetId).toMatch(/^sha256-/);
    expect(prepared.project.pages[1].assetId).toBe('appended');
    await expect(openProjectFile(prepared)).rejects.toThrow('置き換える');
    expect(assets.get('original')).toBe(original);
  });

  it('distinguishes legacy backups from project files even if renamed', async () => {
    const backup = await exportBackup(project);
    const zip = await JSZip.loadAsync(await backup.arrayBuffer());
    expect(JSON.parse(await zip.file('project.json')!.async('string'))).toMatchObject({
      format: 'lectern',
      version: 2,
    });
    await expect(prepareProjectFile(new File([backup], '資料.lectern'))).rejects.toThrow(
      '.lectern',
    );
  });
});
