import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { Project } from './model';
import type { OneDriveClient, OneDriveFile } from './oneDrive';
import {
  download,
  exportProjectFile,
  getProjectFileTarget,
  openProjectFile,
  prepareProjectFile,
  sameProjectFileTarget,
  updateProjectFileTarget,
} from './storage';
import type { OneDriveProjectTarget, PreparedProjectFile } from './storage';

type RunOperation = (label: string, action: () => Promise<void>) => Promise<void>;
type SaveTarget = { handle: FileSystemFileHandle; size: number; lastModified: number };
type OneDrive = { getClient: () => Promise<{ accountId: string; client: OneDriveClient }> };
type Session = {
  id?: string;
  target?: SaveTarget;
  oneDriveTarget?: OneDriveProjectTarget;
  targetError?: unknown;
};
type Pending = { prepared: PreparedProjectFile; target?: OneDriveProjectTarget };
type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

function projectFilename(title: string) {
  const clean = Array.from(title, (c) =>
    c.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(c) ? '_' : c,
  ).join('');
  // Leave room for the extension on filesystems that limit the name in UTF-8 bytes.
  const encoder = new TextEncoder();
  let stem = '',
    bytes = 0;
  for (const c of clean.trim()) {
    bytes += encoder.encode(c).length;
    if (bytes > 240) break;
    stem += c;
  }
  stem = stem.replace(/[. ]+$/, '') || '講義資料';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(stem)) stem = '_' + stem;
  return stem + '.lectern';
}

export function useProjectFile(
  projectId: string | undefined,
  open: (project: Project) => Promise<void>,
  run: RunOperation,
  oneDrive: OneDrive,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const session = useRef<Session>({ id: projectId });
  const running = useRef(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [cloudBinding, setCloudBinding] = useState<{
    projectId: string;
    target?: OneDriveProjectTarget;
  } | null>(null);
  const [fileNotice, setFileNotice] = useState('');
  useLayoutEffect(() => {
    session.current = { id: projectId };
    setPending(null);
    setCloudBinding(null);
    setFileNotice('');
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    const active = session.current;
    void getProjectFileTarget(projectId).then(
      (target) => {
        if (active !== session.current) return;
        active.oneDriveTarget = target;
        setCloudBinding({ projectId, target });
      },
      (error) => {
        if (active !== session.current) return;
        active.targetError = error;
        setCloudBinding({ projectId });
      },
    );
  }, [projectId]);
  useEffect(() => {
    if (!fileNotice) return;
    const timer = setTimeout(() => setFileNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [fileNotice]);

  const perform = async (label: string, action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    try {
      await run(label, action);
    } finally {
      running.current = false;
    }
  };
  const chooseFile = () => inputRef.current?.click();
  const openArchive = async (file: File, target?: OneDriveProjectTarget) => {
    const prepared = await prepareProjectFile(file);
    if (prepared.conflict) setPending({ prepared, target });
    else await open(await openProjectFile(prepared, { target }));
  };
  const readInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    void perform('プロジェクトを開いています…', () => openArchive(file));
  };
  const openOneDrive = (file: OneDriveFile) => {
    // Opening from the library ensures the current project's local edits have finished saving.
    if (session.current.id) return;
    void perform('OneDriveのプロジェクトを開いています…', async () => {
      const { accountId, client } = await oneDrive.getClient();
      const { file: archive, item } = await client.download(file);
      await openArchive(archive, { ...item, accountId });
    });
  };
  const resolveConflict = (onConflict: 'replace' | 'keep-local') => {
    if (!pending) return;
    setPending(null);
    void perform('プロジェクトを開いています…', async () => {
      await open(await openProjectFile(pending.prepared, { onConflict, target: pending.target }));
    });
  };
  const saveToOneDrive = async (
    project: Project,
    active: Session,
    target: OneDriveProjectTarget,
  ) => {
    const { client, accountId } = await oneDrive.getClient();
    if (accountId !== target.accountId)
      throw new Error('保存先に紐づいているMicrosoftアカウントでサインインしてください。');
    const archive = await exportProjectFile(project);
    const stored = await getProjectFileTarget(project.id);
    if (!sameProjectFileTarget(stored, target)) {
      if (active === session.current) {
        active.oneDriveTarget = stored;
        setCloudBinding({ projectId: project.id, target: stored });
      }
      throw new Error('この端末で保存先が変更されました。現在の保存先を確認してください。');
    }
    const saved = { ...(await client.save(target, archive)), accountId };
    const updated = await updateProjectFileTarget(project.id, target, saved);
    if (active !== session.current) return;
    if (updated) {
      active.oneDriveTarget = saved;
      setCloudBinding({ projectId: project.id, target: saved });
      setFileNotice(`OneDriveの「${saved.name}」に保存しました。`);
    } else {
      const latest = await getProjectFileTarget(project.id);
      if (active !== session.current) return;
      active.oneDriveTarget = latest;
      setCloudBinding({ projectId: project.id, target: latest });
      setFileNotice(`OneDriveの「${saved.name}」に保存しました。現在の保存先は変更されています。`);
    }
  };
  const saveLocalFile = (project: Project) => {
    const active = session.current;
    if (active.id !== project.id) return;
    void perform('プロジェクトのコピーを保存しています…', async () => {
      setFileNotice('');
      const filename = projectFilename(project.name);
      download(await exportProjectFile(project), filename);
      if (active === session.current)
        setFileNotice(`「${filename}」のダウンロードを開始しました。`);
    });
  };
  const saveReady = cloudBinding?.projectId === projectId;
  const saveFile = (project: Project) => {
    const active = session.current;
    if (active.id !== project.id || !saveReady) return;
    const target = active.oneDriveTarget;
    if (target) {
      void perform('OneDriveに保存しています…', async () => {
        setFileNotice('');
        await saveToOneDrive(project, active, target);
      });
      return;
    }
    void perform('プロジェクトを保存しています…', async () => {
      setFileNotice('');
      if (active.targetError) throw active.targetError;
      const filename = projectFilename(project.name);
      const browser = window as Window & { showSaveFilePicker?: SavePicker };
      const previous = active.target;
      let handle = previous?.handle;
      if (!handle && typeof browser.showSaveFilePicker === 'function') {
        // The picker must open in the original click, before preparing a large PDF.
        try {
          handle = await browser.showSaveFilePicker({
            suggestedName: filename,
            types: [
              {
                description: 'Lectern プロジェクト',
                accept: { 'application/octet-stream': ['.lectern'] },
              },
            ],
          });
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          if (!(
            error instanceof DOMException &&
            ['SecurityError', 'NotSupportedError'].includes(error.name)
          ))
            throw error;
        }
      }
      const blob = await exportProjectFile(project);
      if (!handle) {
        download(blob, filename);
        if (active === session.current)
          setFileNotice(`「${filename}」のダウンロードを開始しました。`);
        return;
      }
      // Forget stale or revoked handles so another Save can choose a different file.
      active.target = undefined;
      if (previous) {
        const disk = await handle.getFile();
        if (disk.lastModified !== previous.lastModified || disk.size !== previous.size) {
          throw new Error(
            '保存先のファイルは別の端末またはアプリで変更されました。最新のファイルを開くか、もう一度「プロジェクトを保存」で別名のコピーを保存してください。',
          );
        }
      }
      const stream = await handle.createWritable();
      try {
        await stream.write(blob);
        await stream.close();
      } catch (error) {
        await stream.abort().catch(() => {});
        throw error;
      }
      const saved = await handle.getFile().catch(() => undefined);
      if (active !== session.current) return;
      if (saved) active.target = { handle, size: saved.size, lastModified: saved.lastModified };
      setFileNotice(`「${handle.name}」を保存しました。`);
    });
  };

  return {
    inputRef,
    chooseFile,
    readInput,
    openOneDrive,
    saveFile,
    saveLocalFile,
    saveReady,
    oneDriveTarget: saveReady ? cloudBinding?.target : undefined,
    fileNotice,
    conflict: pending?.prepared.existing
      ? {
          incoming: pending.prepared.project,
          local: pending.prepared.existing,
          fromOneDrive: Boolean(pending.target),
        }
      : null,
    cancelConflict: () => setPending(null),
    replaceConflict: () => resolveConflict('replace'),
    keepLocalAndLink: () => resolveConflict('keep-local'),
  };
}
