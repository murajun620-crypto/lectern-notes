import { useEffect, useState } from 'react';
import { FileText, Folder, Loader2 } from 'lucide-react';
import type {
  OneDriveClient,
  OneDriveFile,
  OneDriveFolder,
  OneDriveFolderListing,
} from './oneDrive';

type Props = {
  ready: boolean;
  account: { id: string; label: string } | null;
  authError: string;
  busy: boolean;
  signIn: () => void;
  signOut: () => void;
  getClient: () => Promise<{ accountId: string; client: OneDriveClient }>;
  onOpen: (file: OneDriveFile) => void;
};

export function OneDrivePicker({
  ready,
  account,
  authError,
  busy,
  signIn,
  signOut,
  getClient,
  onOpen,
}: Props) {
  const [path, setPath] = useState<OneDriveFolder[]>([]);
  const [listing, setListing] = useState<OneDriveFolderListing | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const folder = path.at(-1);
  const accountId = account?.id;

  useEffect(() => {
    if (!accountId) return;
    let current = true;
    setListing(null);
    setError('');
    void getClient()
      .then(({ client }) => client.listFolder(folder))
      .then((result) => {
        if (current) setListing(result);
      })
      .catch((reason: unknown) => {
        if (current)
          setError(reason instanceof Error ? reason.message : 'フォルダを開けませんでした。');
      });
    return () => {
      current = false;
    };
  }, [accountId, attempt, folder, getClient]);

  if (!ready) return <p role="status">OneDriveに接続しています…</p>;
  if (!account) {
    return (
      <>
        <p>勤務先または学校のMicrosoftアカウントでサインインしてください。</p>
        {authError && (
          <p className="field-error" role="alert">
            {authError}
          </p>
        )}
        <button className="primary" disabled={busy} onClick={signIn}>
          Microsoftでサインイン
        </button>
      </>
    );
  }

  return (
    <div className="onedrive-picker">
      <div className="onedrive-account">
        <span>{account.label}</span>
        <button className="text-button" disabled={busy} onClick={signOut}>
          サインアウト
        </button>
      </div>
      <nav className="onedrive-path" aria-label="OneDriveのフォルダ">
        <button disabled={!folder} onClick={() => setPath([])}>
          マイ ファイル
        </button>
        {path.map((entry, index) => (
          <button
            key={entry.id}
            disabled={index === path.length - 1}
            onClick={() => setPath(path.slice(0, index + 1))}
          >
            {entry.name}
          </button>
        ))}
      </nav>
      {error ? (
        <>
          <p className="field-error" role="alert">
            {error}
          </p>
          <div className="onedrive-account">
            <button className="secondary" onClick={() => setAttempt((n) => n + 1)}>
              再試行
            </button>
            <button className="text-button" disabled={busy} onClick={signIn}>
              サインインし直す
            </button>
          </div>
        </>
      ) : !listing ? (
        <p className="onedrive-loading" role="status">
          <Loader2 className="spin" size={16} />
          読み込み中…
        </p>
      ) : (
        <ul className="onedrive-entries">
          {listing.folders.map((entry) => (
            <li key={entry.id}>
              <button onClick={() => setPath([...path, entry])}>
                <Folder size={18} />
                {entry.name}
              </button>
            </li>
          ))}
          {listing.files.map((file) => (
            <li key={file.id}>
              <button onClick={() => onOpen(file)}>
                <FileText size={18} />
                {file.name}
              </button>
            </li>
          ))}
          {!listing.folders.length && !listing.files.length && (
            <li className="onedrive-empty">このフォルダにLecternプロジェクトはありません。</li>
          )}
        </ul>
      )}
    </div>
  );
}
