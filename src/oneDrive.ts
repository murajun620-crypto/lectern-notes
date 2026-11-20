export type OneDriveFolder = { driveId: string; id: string; name: string };
export type OneDriveFile = OneDriveFolder & { eTag: string; size: number };
export type OneDriveFolderListing = {
  folder: OneDriveFolder;
  folders: OneDriveFolder[];
  files: OneDriveFile[];
};
export type OneDriveClient = {
  listFolder: (folder?: OneDriveFolder) => Promise<OneDriveFolderListing>;
  download: (file: OneDriveFile) => Promise<{ file: File; item: OneDriveFile }>;
  save: (file: OneDriveFile, blob: Blob) => Promise<OneDriveFile>;
};

const graph = 'https://graph.microsoft.com';
const maxSize = 500 * 1024 * 1024;
const chunkSize = 5 * 1024 * 1024; // 16 × 320 KiB, Graph's upload alignment.
const itemFields = '$select=id,name,file,folder,remoteItem,eTag,size,parentReference';

type DriveItem = {
  id?: string;
  name?: string;
  eTag?: string;
  size?: number;
  parentReference?: { driveId?: string };
  folder?: object;
  file?: object;
  remoteItem?: object;
  '@microsoft.graph.downloadUrl'?: string;
};
type Collection = { value?: DriveItem[]; '@odata.nextLink'?: string };

export class OneDriveConflictError extends Error {
  constructor() {
    super('OneDrive上のファイルが更新されています。ライブラリから最新版を開き直してください。');
    this.name = 'OneDriveConflictError';
  }
}

function responseError(status: number, operation: string) {
  switch (status) {
    case 409:
    case 412:
      return new OneDriveConflictError();
    case 401:
      return new Error('OneDriveに再接続してから、もう一度操作してください。');
    case 403:
      return new Error(
        'OneDriveからアクセスが拒否されました。アカウントとファイルの権限を確認してください。',
      );
    case 404:
      return new Error('OneDriveのファイルまたはフォルダが見つかりません。開き直してください。');
    case 423:
      return new Error(
        'OneDriveのファイルがほかのアプリで使用中です。しばらくしてから保存してください。',
      );
    case 429:
      return new Error(
        'OneDriveへのアクセスが混み合っています。しばらくしてから操作してください。',
      );
    case 507:
      return new Error('OneDriveの空き容量が不足しています。');
    default:
      return new Error(`${operation}（OneDrive HTTP ${status}）。`);
  }
}

function dataError() {
  return new Error('OneDriveからファイル情報を取得できませんでした。開き直してください。');
}

function graphFile(driveId: string, item: DriveItem): OneDriveFile | undefined {
  if (
    item.remoteItem ||
    item.folder ||
    !item.file ||
    typeof item.id !== 'string' ||
    !item.id ||
    typeof item.name !== 'string' ||
    !/\.lectern$/i.test(item.name) ||
    typeof item.eTag !== 'string' ||
    !item.eTag ||
    typeof item.size !== 'number' ||
    !Number.isSafeInteger(item.size) ||
    item.size < 0 ||
    (item.parentReference?.driveId && item.parentReference.driveId !== driveId)
  )
    return;
  return { driveId, id: item.id, name: item.name, eTag: item.eTag, size: item.size };
}

function graphFolder(driveId: string, item: DriveItem): OneDriveFolder | undefined {
  if (
    item.remoteItem ||
    !item.folder ||
    typeof item.id !== 'string' ||
    !item.id ||
    typeof item.name !== 'string' ||
    (item.parentReference?.driveId && item.parentReference.driveId !== driveId)
  )
    return;
  return { driveId, id: item.id, name: item.name };
}

function itemUrl({ driveId, id }: OneDriveFolder) {
  return `/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}`;
}

function signedUrl(value: string | undefined): URL {
  if (!value) throw dataError();
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw dataError();
  return url;
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    const data = await response.json();
    if (!data || typeof data !== 'object') throw dataError();
    return data as T;
  } catch {
    throw dataError();
  }
}

export function createOneDriveClient(
  getToken: () => Promise<string>,
  request: typeof fetch = fetch,
): OneDriveClient {
  async function send(url: URL, init: RequestInit, operation: string) {
    let response: Response;
    try {
      response = await request(url, { credentials: 'omit', cache: 'no-store', ...init });
    } catch {
      throw new Error(`${operation}。ネットワークに接続してから、もう一度操作してください。`);
    }
    if (!response.ok) throw responseError(response.status, operation);
    return response;
  }

  async function graphJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, graph);
    if (url.origin !== graph || !url.pathname.startsWith('/v1.0/') || url.username || url.password)
      throw dataError();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await getToken()}`);
    const response = await send(
      url,
      { ...init, headers, redirect: 'error' },
      'OneDriveにアクセスできませんでした',
    );
    return readJson<T>(response);
  }

  async function rootFolder() {
    const root = await graphJson<DriveItem>(`/v1.0/me/drive/root?${itemFields}`);
    const driveId =
      root.parentReference?.driveId ??
      (await graphJson<{ id?: string }>('/v1.0/me/drive?$select=id')).id;
    if (!driveId) throw dataError();
    const folder = graphFolder(driveId, root);
    if (!folder) throw dataError();
    return folder;
  }

  async function listFolder(folder?: OneDriveFolder): Promise<OneDriveFolderListing> {
    const parent = folder ?? (await rootFolder());
    const folders: OneDriveFolder[] = [];
    const files: OneDriveFile[] = [];
    let next: string | undefined = `${itemUrl(parent)}/children?${itemFields}`;
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next)) throw dataError();
      seen.add(next);
      const collection: Collection = await graphJson(next);
      if (!Array.isArray(collection.value)) throw dataError();
      for (const item of collection.value) {
        const folder = graphFolder(parent.driveId, item);
        if (folder) folders.push(folder);
        const file = graphFile(parent.driveId, item);
        if (file) files.push(file);
      }
      next = collection['@odata.nextLink'];
    }
    return { folder: parent, folders, files };
  }

  async function metadata(file: OneDriveFile, includeUrl = false) {
    const fields = itemFields + (includeUrl ? ',@microsoft.graph.downloadUrl' : '');
    const data = await graphJson<DriveItem>(`${itemUrl(file)}?${fields}`);
    const item = graphFile(file.driveId, data);
    if (!item || item.id !== file.id) throw dataError();
    return { item, downloadUrl: data['@microsoft.graph.downloadUrl'] };
  }

  async function verifyVersion(file: OneDriveFile) {
    const { item } = await metadata(file);
    if (item.eTag !== file.eTag || item.size !== file.size) throw new OneDriveConflictError();
  }

  async function download(file: OneDriveFile) {
    const { item, downloadUrl } = await metadata(file, true);
    if (item.size > maxSize) throw new Error('プロジェクトファイルは500 MB以下にしてください。');
    // JavaScript must follow Graph's preauthenticated URL without an authorization header.
    const response = await send(signedUrl(downloadUrl), {}, 'OneDriveから読み込めませんでした');
    const blob = await response.blob();
    await verifyVersion(item);
    if (blob.size !== item.size) throw dataError();
    return { item, file: new File([blob], item.name, { type: 'application/octet-stream' }) };
  }

  async function save(file: OneDriveFile, blob: Blob): Promise<OneDriveFile> {
    if (blob.size < 1 || blob.size > maxSize)
      throw new Error('プロジェクトファイルは500 MB以下にしてください。');
    if (!file.eTag) throw dataError();
    const { uploadUrl } = await graphJson<{ uploadUrl?: string }>(
      `${itemUrl(file)}/createUploadSession`,
      { method: 'POST', headers: { 'If-Match': file.eTag } },
    );
    const url = signedUrl(uploadUrl);
    try {
      for (let start = 0; start < blob.size; start += chunkSize) {
        const end = Math.min(start + chunkSize, blob.size);
        const final = end === blob.size;
        // Session creation checks the eTag. Check again just before the request that commits
        // the content, so edits made while the earlier fragments were uploading are caught.
        if (final) await verifyVersion(file);
        const response = await send(
          url,
          {
            method: 'PUT',
            redirect: 'error',
            headers: { 'Content-Range': `bytes ${start}-${end - 1}/${blob.size}` },
            body: blob.slice(start, end),
          },
          'OneDriveへの保存を完了できませんでした',
        );
        if (response.status === 202 && !final) continue;
        if (final && (response.status === 200 || response.status === 201)) {
          const item = graphFile(file.driveId, await readJson<DriveItem>(response));
          if (item?.id === file.id && item.size === blob.size) return item;
          throw new Error(
            'OneDriveに保存した版を確認できませんでした。ファイルを開き直してください。',
          );
        }
        throw new Error('OneDriveへの保存を確認できませんでした。ファイルを開き直してください。');
      }
      throw dataError();
    } catch (error) {
      void request(url, { method: 'DELETE', redirect: 'error', credentials: 'omit' }).catch(
        () => {},
      );
      throw error;
    }
  }

  return { listFolder, download, save };
}
