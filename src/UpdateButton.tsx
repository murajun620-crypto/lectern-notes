import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, Loader2, RefreshCw, X } from 'lucide-react';

type Version = { version: string; builtAt: string };
export default function UpdateButton({ beforeReload }: { beforeReload: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<
    'closed' | 'checking' | 'latest' | 'available' | 'updating' | 'error'
  >('closed');
  const [version, setVersion] = useState<Version | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    if (phase !== 'closed') dialog.current?.showModal();
    else dialog.current?.close();
  }, [phase]);
  useEffect(() => () => request.current?.abort(), []);
  const check = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    setPhase('checking');
    setError('');
    try {
      const url = new URL(`${import.meta.env.BASE_URL}version.json`, location.href);
      url.searchParams.set('check', String(Date.now()));
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('更新情報を取得できませんでした。');
      const data: Version = await response.json();
      if (request.current !== controller) return;
      if (
        typeof data.version !== 'string' ||
        !/^[\w.-]{1,100}$/.test(data.version) ||
        typeof data.builtAt !== 'string'
      )
        throw new Error('更新情報の形式を確認できませんでした。');
      setVersion(data);
      setPhase(data.version === __APP_VERSION__ ? 'latest' : 'available');
    } catch {
      if (request.current === controller) {
        setError(
          '更新を確認できませんでした。通信環境を確認して再試行してください。現在の画面では引き続き作業できます。',
        );
        setPhase('error');
      }
    } finally {
      clearTimeout(timeout);
    }
  };
  const apply = async () => {
    if (!version) return;
    setPhase('updating');
    try {
      await beforeReload();
      const url = new URL(location.href);
      url.searchParams.set('v', version.version);
      location.replace(url.href);
    } catch (e) {
      setError(
        `更新を中止しました。${e instanceof Error ? e.message : '教材の保存に失敗しました。'}`,
      );
      setPhase('error');
    }
  };
  const close = () => {
    if (phase === 'updating') return;
    request.current?.abort();
    request.current = null;
    setPhase('closed');
  };
  return (
    <>
      <button className="secondary update-button" onClick={() => void check()} title="更新確認">
        <RefreshCw size={16} />
        <span>更新確認</span>
      </button>
      <dialog
        ref={dialog}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <div className="modal-top">
          <h2>アプリの更新確認</h2>
          <button
            className="icon-button"
            aria-label="更新確認を閉じる"
            onClick={close}
            disabled={phase === 'updating'}
          >
            <X size={20} />
          </button>
        </div>
        <div className="update-status" role="status">
          {phase === 'checking' || phase === 'updating' ? (
            <>
              <Loader2 className="spin" size={28} />
              <p>
                {phase === 'updating' ? '教材を保存して更新しています…' : '公開版を確認しています…'}
              </p>
            </>
          ) : phase === 'latest' ? (
            <>
              <CheckCircle2 size={30} />
              <h3>最新版を利用しています</h3>
              <p>このまま講義を続けられます。</p>
            </>
          ) : phase === 'available' ? (
            <>
              <Download size={30} />
              <h3>新しいバージョンがあります</h3>
              <p>
                教材と書き込みを保存してから更新します。
                <br />
                この端末の資料はそのまま引き継がれます。
              </p>
            </>
          ) : phase === 'error' ? (
            <p className="field-error">{error}</p>
          ) : null}
        </div>
        <div className="modal-actions">
          {phase === 'available' ? (
            <>
              <button className="secondary" onClick={close}>
                あとで
              </button>
              <button className="primary" onClick={() => void apply()}>
                保存して更新
              </button>
            </>
          ) : phase === 'error' ? (
            <>
              <button className="secondary" onClick={close}>
                閉じる
              </button>
              <button className="primary" onClick={() => void check()}>
                再試行
              </button>
            </>
          ) : phase === 'latest' ? (
            <button className="primary" onClick={close}>
              閉じる
            </button>
          ) : null}
        </div>
      </dialog>
    </>
  );
}
