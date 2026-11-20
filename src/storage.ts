import { openDB } from 'idb';
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import JSZip from 'jszip';
import { isPenKind, uid } from './model';
import type { Project, Page } from './model';
import type { OneDriveFile } from './oneDrive';
import { videoPlacementBounds } from './video-layout';
let connection: ReturnType<typeof openDB> | undefined;
function db() {
  if (connection) return connection;
  const opened = openDB('lectern', 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('assets');
      }
      if (oldVersion < 2) db.createObjectStore('projectFileTargets');
    },
    blocking(_old, _next, event) {
      (event.target as IDBDatabase).close();
      forget();
    },
    terminated: forget,
  });
  function forget() {
    if (connection === opened) connection = undefined;
  }
  connection = opened;
  void opened.catch(forget);
  return opened;
}
const interrupted = new Set([
  'AbortError',
  'InvalidStateError',
  'UnknownError',
  'TransactionInactiveError',
]);
async function storageError(action: string, e: unknown) {
  const name = e instanceof Error ? e.name : 'Error';
  const detail = e instanceof Error ? e.message : String(e);
  let reason = detail || '詳細を取得できませんでした。';
  if (name === 'QuotaExceededError') {
    reason = 'このブラウザの保存容量が不足しています。';
    try {
      const estimate = await navigator.storage?.estimate();
      if (estimate?.usage !== undefined && estimate.quota) {
        const mib = (bytes: number) =>
          (bytes / 1048576).toLocaleString('ja-JP', { maximumFractionDigits: 1 });
        reason += ` サイトの使用量は約${mib(estimate.usage)} MiB、上限は約${mib(estimate.quota)} MiBです。`;
      }
    } catch {
      /* Storage estimates are optional. */
    }
  } else if (name === 'SecurityError' || name === 'NotAllowedError') {
    reason = 'ブラウザがサイトデータへのアクセスを制限しています。';
  } else if (name === 'DataCloneError') {
    reason = '教材にブラウザが保存形式へ変換できないデータが含まれています。';
  } else if (interrupted.has(name)) {
    reason = `ブラウザの保存処理を完了できませんでした。${detail}`;
  }
  return new Error(`${action}。${reason}（${name}）`, { cause: e });
}
async function withStorage<T>(
  action: string,
  operation: (database: IDBPDatabase) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let active: typeof connection;
    try {
      active = db();
      return await operation(await active);
    } catch (error) {
      if (error instanceof Error && interrupted.has(error.name)) {
        if (connection === active) connection = undefined;
        await active?.then(
          (database) => database.close(),
          () => {},
        );
        if (attempt === 0) continue;
      }
      throw await storageError(action, error);
    }
  }
}
export const listProjects = async (): Promise<Project[]> =>
  (
    await withStorage('教材一覧を読み込めませんでした', (database) => database.getAll('projects'))
  ).sort((a, b) => b.updatedAt - a.updatedAt);
export const saveProject = async (p: Project) => {
  await withStorage('教材を保存できませんでした', (database) => database.put('projects', p));
};

export type OneDriveProjectTarget = OneDriveFile & { accountId: string };

export function getProjectFileTarget(
  projectId: string,
): Promise<OneDriveProjectTarget | undefined> {
  return withStorage('OneDriveの保存先を確認できませんでした', (database) =>
    database.get('projectFileTargets', projectId),
  );
}

export function sameProjectFileTarget(
  a: OneDriveProjectTarget | undefined,
  b: OneDriveProjectTarget | undefined,
) {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.accountId === b.accountId &&
      a.driveId === b.driveId &&
      a.id === b.id &&
      a.name === b.name &&
      a.eTag === b.eTag &&
      a.size === b.size)
  );
}

function writeTransaction(
  action: string,
  stores: string[],
  write: (tx: IDBPTransaction<unknown, string[], 'readwrite'>) => Promise<void>,
) {
  return withStorage(action, async (database) => {
    const tx = database.transaction(stores, 'readwrite');
    try {
      await Promise.all([write(tx), tx.done]);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already aborted by IndexedDB. */
      }
      await tx.done.catch(() => {});
      throw error;
    }
  });
}

export async function updateProjectFileTarget(
  projectId: string,
  expected: OneDriveProjectTarget,
  next: OneDriveProjectTarget,
) {
  let updated = false;
  await writeTransaction(
    'OneDriveの保存先を更新できませんでした',
    ['projectFileTargets'],
    async (tx) => {
      updated = false;
      const targets = tx.objectStore('projectFileTargets');
      if (!sameProjectFileTarget(await targets.get(projectId), expected)) return;
      await targets.put(next, projectId);
      updated = true;
    },
  );
  return updated;
}

export async function setProjectTags(id: string, tags: Pick<Project, 'subject' | 'academicYear'>) {
  await writeTransaction('タグを保存できませんでした', ['projects'], async (tx) => {
    const store = tx.objectStore('projects');
    const project: Project | undefined = await store.get(id);
    if (!project) throw new Error('この資料はライブラリにありません。');
    // The card may predate ink saved from another window.
    await store.put({ ...project, ...tags, updatedAt: Date.now() });
  });
}
export function saveProjectWithPdf(project: Project, asset: { id: string; data: ArrayBuffer }) {
  return writeTransaction('PDFと教材を保存できませんでした', ['assets', 'projects'], async (tx) => {
    await tx.objectStore('assets').put(asset.data, asset.id);
    await tx.objectStore('projects').put(project);
  });
}
export const getAsset = async (id: string): Promise<ArrayBuffer> => {
  const a = await withStorage('元のPDFを読み込めませんでした', (database) =>
    database.get('assets', id),
  );
  if (!a) throw new Error('PDFデータが見つかりません。バックアップから復元してください。');
  return a;
};
export async function deleteProject(id: string) {
  await writeTransaction(
    '教材を削除できませんでした',
    ['projects', 'assets', 'projectFileTargets'],
    async (tx) => {
      await tx.objectStore('projects').delete(id);
      await tx.objectStore('projectFileTargets').delete(id);
      const projects: Project[] = await tx.objectStore('projects').getAll();
      const used = new Set(
        projects.flatMap((p) => p.pages.flatMap((page) => (page.assetId ? [page.assetId] : []))),
      );
      for (const key of await tx.objectStore('assets').getAllKeys())
        if (!used.has(String(key))) await tx.objectStore('assets').delete(key);
    },
  );
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
type ArchiveFormat = 'lectern' | 'lectern-project';
export const projectFileSignature = 'LECTERN/1\n';
const fileSizeLimit = 500 * 1024 * 1024;
function assetIds(project: Project) {
  return new Set(project.pages.flatMap((pg) => (pg.assetId ? [pg.assetId] : [])));
}
async function exportArchive(p: Project, format: ArchiveFormat) {
  const zip = new JSZip();
  const version = format === 'lectern' ? 2 : 1;
  zip.file('project.json', JSON.stringify({ format, version, project: p }));
  for (const id of assetIds(p)) zip.file(`assets/${id}.pdf`, await getAsset(id));
  if (format === 'lectern') return zip.generateAsync({ type: 'blob', compression: 'STORE' });
  // JSZip's normal Blob output first concatenates every byte into a single Uint8Array.
  // Let the browser assemble the signed file directly from chunks on memory-limited iPads.
  return new Promise<Blob>((resolve, reject) => {
    const parts: BlobPart[] = [projectFileSignature];
    const stream = zip.generateInternalStream({
      type: 'uint8array',
      compression: 'STORE',
      streamFiles: true,
    });
    let size = projectFileSignature.length;
    stream
      .on('data', (chunk) => {
        size += chunk.byteLength;
        if (size > fileSizeLimit) {
          stream.pause();
          reject(new Error('プロジェクトファイルは500 MB以下にしてください。'));
        } else parts.push(chunk);
      })
      .on('error', reject)
      .on('end', () => {
        try {
          resolve(new Blob(parts, { type: 'application/octet-stream' }));
        } catch (error) {
          reject(error);
        }
      })
      .resume();
  });
}
export const exportBackup = (p: Project) => exportArchive(p, 'lectern');
export const exportProjectFile = (p: Project) => exportArchive(p, 'lectern-project');
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
    (q.subject !== undefined &&
      (typeof q.subject !== 'string' || !q.subject.trim() || q.subject.length > 80)) ||
    (q.academicYear !== undefined &&
      (typeof q.academicYear !== 'string' || !/^\d{4}$/.test(q.academicYear))) ||
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
        (s.penKind !== undefined && (s.tool !== 'pen' || !isPenKind(s.penKind))) ||
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
        (v.collapsed !== undefined && typeof v.collapsed !== 'boolean') ||
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
async function readArchive(file: File, format: ArchiveFormat) {
  if (file.size > fileSizeLimit) throw new Error('ファイルは500 MB以下にしてください。');
  let body: Blob = file;
  if (format === 'lectern-project') {
    const header = await file.slice(0, projectFileSignature.length).text();
    if (header !== projectFileSignature)
      throw new Error('対応するLecternプロジェクト（.lectern）を選択してください。');
    body = file.slice(projectFileSignature.length);
  }
  const zip = await JSZip.loadAsync(await body.arrayBuffer());
  // Check declared inflated lengths before decompressing untrusted ZIP content.
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    total +=
      (entry as unknown as { _data?: { uncompressedSize: number } })._data?.uncompressedSize || 0;
  }
  if (total > 750 * 1024 * 1024 || Object.keys(zip.files).length > 4000)
    throw new Error('ファイルの展開サイズが大きすぎます。');
  const meta = zip.file('project.json');
  if (!meta) throw new Error('Lecternの資料データが見つかりません。');
  const raw = JSON.parse(await meta.async('string'));
  const versions = format === 'lectern' ? [1, 2] : [1];
  if (!raw || raw.format !== format || !versions.includes(raw.version))
    throw new Error(
      format === 'lectern'
        ? '未対応のバックアップ形式です。'
        : 'Lecternプロジェクト（.lectern）を選択してください。',
    );
  validateProject(raw.project);
  return { project: raw.project as Project, zip };
}
async function readPdfAsset(zip: JSZip, assetId: string) {
  const entry = zip.file(`assets/${assetId}.pdf`);
  if (!entry) throw new Error('ファイル内のPDFが不足しています。');
  const data = await entry.async('arraybuffer');
  if (
    !new TextDecoder()
      .decode(new Uint8Array(data, 0, Math.min(1024, data.byteLength)))
      .includes('%PDF-')
  )
    throw new Error('ファイル内のPDFが不正です。');
  return data;
}
export async function importBackup(file: File): Promise<Project> {
  const { project: p, zip } = await readArchive(file, 'lectern');
  const assets = new Map<string, string>(),
    pending: { id: string; data: ArrayBuffer }[] = [];
  for (const assetId of assetIds(p)) {
    const id = uid();
    assets.set(assetId, id);
    pending.push({ id, data: await readPdfAsset(zip, assetId) });
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
  await writeTransaction(
    'バックアップを復元できませんでした',
    ['assets', 'projects'],
    async (tx) => {
      for (const a of pending) await tx.objectStore('assets').put(a.data, a.id);
      await tx.objectStore('projects').put(restored);
    },
  );
  return restored;
}

export type PreparedProjectFile = {
  project: Project;
  existing: Project | undefined;
  existingTarget: OneDriveProjectTarget | undefined;
  conflict: boolean;
  assets: Map<string, ArrayBuffer>;
};

// Never write a file-supplied asset ID to the shared store. Identical PDF bytes can be
// shared across documents, and changing a PDF always creates a new PDF.js cache key.
async function pdfContentKey(data: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return 'sha256-' + Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function editableContent(p: Project, canonical: Map<string, string>) {
  const pages = p.pages.map((pg) =>
    pg.assetId ? { ...pg, assetId: canonical.get(pg.assetId) ?? pg.assetId } : pg,
  );
  return JSON.stringify([p.name, p.subject, p.academicYear, pages]);
}

export async function prepareProjectFile(file: File): Promise<PreparedProjectFile> {
  const { project: incoming, zip } = await readArchive(file, 'lectern-project');
  const safeId = /^[\w-]{1,80}$/;
  if (
    typeof incoming.id !== 'string' ||
    !safeId.test(incoming.id) ||
    !finite(incoming.createdAt, 0, 8.64e15) ||
    !finite(incoming.updatedAt, 0, 8.64e15) ||
    incoming.pages.some((page) => !safeId.test(page.id))
  ) {
    throw new Error('プロジェクトの識別子または日時が不正です。');
  }
  const [existing, existingTarget] = await withStorage(
    '教材を確認できませんでした',
    async (database): Promise<[Project | undefined, OneDriveProjectTarget | undefined]> => {
      const tx = database.transaction(['projects', 'projectFileTargets'], 'readonly');
      const [existing, existingTarget] = await Promise.all([
        tx.objectStore('projects').get(incoming.id),
        tx.objectStore('projectFileTargets').get(incoming.id),
        tx.done,
      ]);
      return [existing, existingTarget];
    },
  );
  const localByContent = new Map<string, string>();
  const contentByLocal = new Map<string, string>();
  if (existing) {
    for (const id of assetIds(existing)) {
      let hash: string | undefined;
      if (/^sha256-[0-9a-f]{64}$/.test(id)) {
        const key = await withStorage('元のPDFを確認できませんでした', (database) =>
          database.getKey('assets', id),
        );
        if (key) hash = id;
      } else {
        const data: ArrayBuffer | undefined = await withStorage(
          '元のPDFを確認できませんでした',
          (database) => database.get('assets', id),
        );
        if (data) hash = await pdfContentKey(data);
      }
      if (hash) {
        localByContent.set(hash, id);
        contentByLocal.set(id, hash);
      }
    }
  }
  const assets = new Map<string, ArrayBuffer>();
  const mapped = new Map<string, string>();
  for (const id of assetIds(incoming)) {
    const data = await readPdfAsset(zip, id);
    const hash = await pdfContentKey(data);
    // Keep distinct local references when a PDF was appended twice before export.
    const localId = contentByLocal.get(id) === hash ? id : localByContent.get(hash);
    mapped.set(id, localId ?? hash);
    if (!localId) assets.set(hash, data);
  }
  const project = {
    ...incoming,
    pages: incoming.pages.map((pg) =>
      pg.assetId ? { ...pg, assetId: mapped.get(pg.assetId)! } : pg,
    ),
  };
  return {
    project,
    existing,
    existingTarget,
    conflict:
      !!existing &&
      editableContent(existing, contentByLocal) !== editableContent(project, contentByLocal),
    assets,
  };
}

export async function openProjectFile(
  prepared: PreparedProjectFile,
  options: { onConflict?: 'replace' | 'keep-local'; target?: OneDriveProjectTarget } = {},
): Promise<Project> {
  const { project, existing, existingTarget, conflict, assets } = prepared;
  const { onConflict, target } = options;
  if (conflict && !onConflict) throw new Error('この端末の資料を置き換えるか選んでください。');
  if (onConflict === 'keep-local' && (!target || !existing))
    throw new Error('この端末の資料をOneDriveに紐づけられませんでした。');
  let opened = project;
  await writeTransaction(
    'プロジェクトを開けませんでした',
    ['projects', 'assets', 'projectFileTargets'],
    async (tx) => {
      const projects = tx.objectStore('projects');
      const targets = tx.objectStore('projectFileTargets');
      const stored: Project | undefined = await projects.get(project.id);
      if (
        JSON.stringify(stored) !== JSON.stringify(existing) ||
        !sameProjectFileTarget(await targets.get(project.id), existingTarget)
      )
        throw new Error(
          '確認中にこの端末の資料が変更されました。ファイルをもう一度開いてください。',
        );
      if (target) await targets.put(target, project.id);
      else if (existingTarget) await targets.delete(project.id);
      if (onConflict === 'keep-local' && stored) {
        opened = stored;
        return;
      }
      const pdfs = tx.objectStore('assets');
      for (const [id, data] of assets)
        if ((await pdfs.getKey(id)) === undefined) await pdfs.add(data, id);
      if (stored && !conflict) {
        opened =
          stored.currentPage === project.currentPage
            ? stored
            : { ...stored, currentPage: project.currentPage };
        if (opened !== stored) await projects.put(opened);
        return;
      }
      await projects.put(project);
      if (stored) {
        const old = assetIds(stored);
        for (const id of assetIds(project)) old.delete(id);
        if (old.size) {
          for (const other of (await projects.getAll()) as Project[])
            for (const id of assetIds(other)) old.delete(id);
          for (const id of old) await pdfs.delete(id);
        }
      }
    },
  );
  return opened;
}
