import { describe, expect, it } from 'vitest';
import { createOneDriveClient, OneDriveConflictError } from './oneDrive';
import type { OneDriveFile } from './oneDrive';

const item: OneDriveFile = {
  driveId: 'drive!id',
  id: 'file!id',
  name: '講義資料.lectern',
  eTag: '"version-1"',
  size: 3,
};
const rootPath = '/v1.0/me/drive/root';
const itemPath = '/v1.0/drives/drive!id/items/file!id';
const sessionPath = itemPath + '/createUploadSession';
const downloadUrl = 'https://files.1drv.com/project';
const uploadUrl = 'https://up.1drv.com/project';
const remoteFile = (options: Partial<OneDriveFile> = {}) => ({
  id: item.id,
  name: item.name,
  eTag: item.eTag,
  size: item.size,
  file: {},
  parentReference: { driveId: item.driveId },
  ...options,
});
type RequestHandler = (url: URL, init: RequestInit, headers: Headers) => Response;
const client = (handler: RequestHandler) =>
  createOneDriveClient(
    async () => 'access-token',
    async (input, init = {}) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe(
        url.origin === 'https://graph.microsoft.com' ? 'Bearer access-token' : null,
      );
      expect(init.credentials).toBe('omit');
      return handler(url, init, headers);
    },
  );

describe('Microsoft Graph project file operations', () => {
  it('lists only folders and Lectern files in the selected drive and follows Microsoft pagination', async () => {
    const graph = client((url) => {
      if (url.pathname === rootPath) {
        return Response.json({
          id: 'root',
          name: 'OneDrive',
          folder: {},
          parentReference: { driveId: item.driveId },
        });
      }
      expect(url.pathname).toBe('/v1.0/drives/drive!id/items/root/children');
      if (url.searchParams.has('$skiptoken')) return Response.json({ value: [remoteFile()] });
      return Response.json({
        value: [
          { id: 'folder-a', name: '講義', folder: {} },
          { id: 'link', name: '共有', folder: {}, remoteItem: { id: 'other-drive' } },
          remoteFile({ name: '講義資料.pdf' }),
          { ...remoteFile(), parentReference: { driveId: 'other-drive' } },
        ],
        '@odata.nextLink': url.origin + url.pathname + '?$skiptoken=second-page',
      });
    });
    expect(await graph.listFolder()).toEqual({
      folder: { driveId: item.driveId, id: 'root', name: 'OneDrive' },
      folders: [{ driveId: item.driveId, id: 'folder-a', name: '講義' }],
      files: [item],
    });
  });

  it('does not attach a stale version when OneDrive changes the file during download', async () => {
    let downloaded = false;
    const graph = client((url) => {
      if (url.href === downloadUrl) {
        downloaded = true;
        return new Response('abc');
      }
      expect(url.pathname).toBe(itemPath);
      return Response.json({
        ...remoteFile({ eTag: downloaded ? '"version-2"' : item.eTag }),
        '@microsoft.graph.downloadUrl': downloadUrl,
      });
    });
    await expect(graph.download(item)).rejects.toBeInstanceOf(OneDriveConflictError);
    expect(downloaded).toBe(true);
  });

  it('saves to the same item in ordered graph-aligned chunks and returns the committed version', async () => {
    const blob = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]);
    const ranges: string[] = [];
    const graph = client((url, init, headers) => {
      if (url.pathname === sessionPath) {
        expect(init.method).toBe('POST');
        expect(headers.get('if-match')).toBe(item.eTag);
        return Response.json({ uploadUrl });
      }
      if (url.pathname === itemPath) {
        expect(ranges).toHaveLength(1);
        return Response.json(remoteFile());
      }
      expect(url.href).toBe(uploadUrl);
      expect(init.method).toBe('PUT');
      ranges.push(headers.get('content-range')!);
      if (ranges.length === 1) {
        expect((init.body as Blob).size).toBe(5 * 1024 * 1024);
        return Response.json({ nextExpectedRanges: ['5242880-'] }, { status: 202 });
      }
      expect((init.body as Blob).size).toBe(1);
      return Response.json(remoteFile({ eTag: '"version-2"', size: blob.size }));
    });
    expect(await graph.save(item, blob)).toEqual({ ...item, eTag: '"version-2"', size: blob.size });
    expect(ranges).toEqual(['bytes 0-5242879/5242881', 'bytes 5242880-5242880/5242881']);
  });

  it('abandons an upload if a different version appears before the committing request', async () => {
    const methods: string[] = [];
    const graph = client((url, init) => {
      if (url.pathname === sessionPath) return Response.json({ uploadUrl });
      if (url.pathname === itemPath) return Response.json(remoteFile({ eTag: '"version-2"' }));
      expect(url.href).toBe(uploadUrl);
      methods.push(init.method!);
      return new Response(null, { status: 204 });
    });
    await expect(graph.save(item, new Blob(['abc']))).rejects.toBeInstanceOf(OneDriveConflictError);
    expect(methods).toEqual(['DELETE']);
  });
});
