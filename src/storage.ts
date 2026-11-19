import { openDB } from 'idb';
import JSZip from 'jszip';
import { uid } from './model';
import type { Project, Page } from './model';
import { videoPlacementBounds } from './video-layout';
let connection: ReturnType<typeof openDB> | undefined;
const db = () =>
  (connection ||= openDB('lectern', 1, {
    upgrade(db) {
      db.createObjectStore('projects', { keyPath: 'id' });
      db.createObjectStore('assets');
    },
  }));
export const listProjects = async (): Promise<Project[]> =>
  (await (await db()).getAll('projects')).sort((a, b) => b.updatedAt - a.updatedAt);
export const saveProject = async (p: Project) => {
  await (await db()).put('projects', p);
};
export const putAsset = async (id: string, data: ArrayBuffer) => {
  await (await db()).put('assets', data, id);
};
export const getAsset = async (id: string): Promise<ArrayBuffer> => {
  const a = await (await db()).get('assets', id);
  if (!a) throw new Error('PDFデータが見つかりません。バックアップから復元してください。');
  return a;
};
export async function deleteProject(id: string) {
  const database = await db(),
    tx = database.transaction(['projects', 'assets'], 'readwrite');
  await tx.objectStore('projects').delete(id);
  const projects: Project[] = await tx.objectStore('projects').getAll();
  const used = new Set(
    projects.flatMap((p) => p.pages.flatMap((page) => (page.assetId ? [page.assetId] : []))),
  );
  for (const key of await tx.objectStore('assets').getAllKeys())
    if (!used.has(String(key))) await tx.objectStore('assets').delete(key);
  await tx.done;
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export async function exportBackup(p: Project) {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify({ format: 'lectern', version: 2, project: p }));
  for (const id of new Set(p.pages.flatMap((pg) => (pg.assetId ? [pg.assetId] : []))))
    zip.file(`assets/${id}.pdf`, await getAsset(id));
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}
const finite = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export function validateProject(p: unknown): asserts p is Project {
  const fail = () => {
    throw new Error('バックアップのデータ形式が不正です。');
  };
  if (!p || typeof p !== 'object') return fail();
  const q = p as Project;
  if (
    typeof q.name !== 'string' ||
    !q.name.trim() ||
    q.name.length > 200 ||
    !Array.isArray(q.pages) ||
    !q.pages.length ||
    q.pages.length > 2000
  )
    return fail();
  if (!finite(q.currentPage, 0, q.pages.length - 1) || !Number.isInteger(q.currentPage))
    return fail();
  const ids = new Set<string>();
  for (const pg of q.pages) {
    if (
      !pg ||
      typeof pg.id !== 'string' ||
      ids.has(pg.id) ||
      !finite(pg.width, 1, 20000) ||
      !finite(pg.height, 1, 20000) ||
      !Array.isArray(pg.strokes) ||
      !Array.isArray(pg.videos) ||
      pg.strokes.length > 100000 ||
      pg.videos.length > 100
    )
      return fail();
    ids.add(pg.id);
    if (
      pg.assetId !== undefined &&
      (typeof pg.assetId !== 'string' ||
        !/^[\w-]{1,80}$/.test(pg.assetId) ||
        !finite(pg.sourcePage, 1, 20000) ||
        !Number.isInteger(pg.sourcePage))
    )
      return fail();
    for (const s of pg.strokes) {
      if (
        !s ||
        typeof s.id !== 'string' ||
        !['pen', 'highlighter'].includes(s.tool) ||
        !/^#[0-9a-f]{6}$/i.test(s.color) ||
        !finite(s.width, 0.1, 100) ||
        !Array.isArray(s.points) ||
        !s.points.length ||
        s.points.length > 200000
      )
        return fail();
      for (const pt of s.points)
        if (
          !pt ||
          !finite(pt.x, -20000, 40000) ||
          !finite(pt.y, -20000, 40000) ||
          !finite(pt.p, 0, 1)
        )
          return fail();
      if (s.erasures !== undefined) {
        if (!Array.isArray(s.erasures) || s.erasures.length > 10000) return fail();
        let count = 0;
        for (const e of s.erasures) {
          if (
            !e ||
            typeof e.id !== 'string' ||
            !finite(e.width, 0.00001, 2000) ||
            !Array.isArray(e.points) ||
            !e.points.length
          )
            return fail();
          count += e.points.length;
          if (count > 200000) return fail();
          for (const pt of e.points)
            if (
              !pt ||
              !finite(pt.x, -20000, 40000) ||
              !finite(pt.y, -20000, 40000) ||
              !finite(pt.p, 0, 1)
            )
              return fail();
        }
      }
    }
    const videoBounds = videoPlacementBounds(pg);
    for (const v of pg.videos)
      if (
        !v ||
        typeof v.id !== 'string' ||
        !/^[\w-]{11}$/.test(v.videoId) ||
        !finite(v.x, videoBounds.left, videoBounds.right) ||
        !finite(v.y, videoBounds.top, videoBounds.bottom) ||
        !finite(v.width, 1, pg.width) ||
        !finite(v.height, 1, pg.height) ||
        v.x + v.width > videoBounds.right + 1 ||
        v.y + v.height > videoBounds.bottom + 1
      )
        return fail();
  }
}
export async function importBackup(file: File): Promise<Project> {
  if (file.size > 500 * 1024 * 1024) throw new Error('バックアップは500 MB以下にしてください。');
  const zip = await JSZip.loadAsync(file);
  // Check declared inflated lengths before decompressing untrusted ZIP content.
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    total +=
      (entry as unknown as { _data?: { uncompressedSize: number } })._data?.uncompressedSize || 0;
  }
  if (total > 750 * 1024 * 1024 || Object.keys(zip.files).length > 4000)
    throw new Error('バックアップの展開サイズが大きすぎます。');
  const meta = zip.file('project.json');
  if (!meta) throw new Error('Lecternのバックアップを選択してください。');
  const raw = JSON.parse(await meta.async('string'));
  if (raw.format !== 'lectern' || ![1, 2].includes(raw.version))
    throw new Error('未対応のバックアップ形式です。');
  validateProject(raw.project);
  const p: Project = raw.project,
    assets = new Map<string, string>(),
    pending: { id: string; data: ArrayBuffer }[] = [];
  for (const pg of p.pages)
    if (pg.assetId && !assets.has(pg.assetId)) {
      const entry = zip.file(`assets/${pg.assetId}.pdf`);
      if (!entry) throw new Error('バックアップ内のPDFが不足しています。');
      const data = await entry.async('arraybuffer');
      if (!new TextDecoder().decode(data.slice(0, 1024)).includes('%PDF-'))
        throw new Error('バックアップ内のPDFが不正です。');
      const id = uid();
      assets.set(pg.assetId, id);
      pending.push({ id, data });
    }
  const restored: Project = {
    ...p,
    id: uid(),
    name: p.name.slice(0, 200),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pages: p.pages.map((pg: Page) => ({
      ...pg,
      id: uid(),
      assetId: pg.assetId ? assets.get(pg.assetId) : undefined,
    })),
  };
  const tx = (await db()).transaction(['assets', 'projects'], 'readwrite');
  for (const a of pending) await tx.objectStore('assets').put(a.data, a.id);
  await tx.objectStore('projects').put(restored);
  await tx.done;
  return restored;
}
