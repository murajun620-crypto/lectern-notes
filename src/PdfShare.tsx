import { useState } from 'react';
import { Download, Share } from 'lucide-react';
import { download } from './storage';

export function PdfShare({ file, onClose }: { file: File; onClose: () => void }) {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState('');
  const [supported] = useState(() => {
    try {
      return typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] });
    } catch {
      return false;
    }
  });
  const share = async () => {
    setError('');
    setSharing(true);
    try {
      // iPadOS needs this call inside the tap, after the asynchronous PDF export has finished.
      await navigator.share({ files: [file] });
      onClose();
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setError('共有シートを開けませんでした。PDFを保存すると、保存先から共有できます。');
      }
    } finally {
      setSharing(false);
    }
  };
  return (
    <>
      <p className="pdf-share-name">{file.name}</p>
      {!supported && <p>PDFを保存すると、保存先からファイルを共有できます。</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button
          className={supported ? 'secondary' : 'primary'}
          disabled={sharing}
          onClick={() => {
            download(file, file.name);
            onClose();
          }}
        >
          <Download size={17} /> PDFを保存
        </button>
        {supported && (
          <button className="primary" disabled={sharing} onClick={share}>
            <Share size={17} /> 共有先を選ぶ
          </button>
        )}
      </div>
    </>
  );
}
