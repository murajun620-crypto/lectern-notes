import { useEffect, useRef, useState } from 'react';
import { Play, X, GripHorizontal, ExternalLink, Trash2, Maximize2 } from 'lucide-react';
import { clamp } from './model';
import type { Video, Page } from './model';
type Player = {
  destroy(): void;
  playVideo(): void;
  pauseVideo(): void;
  getIframe(): HTMLIFrameElement;
};
type YT = { Player: new (el: HTMLElement, options: Record<string, unknown>) => Player };
declare global {
  interface Window {
    YT?: YT;
    onYouTubeIframeAPIReady?: () => void;
  }
}
let loading: Promise<YT> | undefined;
function loadApi(): Promise<YT> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!loading)
    loading = new Promise<YT>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              'YouTubeに接続できません。ネット接続やコンテンツブロッカーを確認してください。',
            ),
          ),
        15000,
      );
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        clearTimeout(timer);
        resolve(window.YT!);
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => {
        clearTimeout(timer);
        script.remove();
        reject(new Error('YouTubeの読み込みに失敗しました。'));
      };
      document.head.append(script);
    }).catch((e) => {
      loading = undefined;
      throw e;
    });
  return loading;
}
export default function VideoBox({
  video: v,
  page,
  editing,
  onChange,
  onDelete,
}: {
  video: Video;
  page: Page;
  editing: boolean;
  onChange: (v: Video) => void;
  onDelete: () => void;
}) {
  const [playing, setPlaying] = useState(false),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false),
    [blocked, setBlocked] = useState(false),
    [playbackState, setPlaybackState] = useState(-1);
  const host = useRef<HTMLDivElement>(null),
    player = useRef<Player | undefined>(undefined);
  const drag = useRef<{
    x: number;
    y: number;
    video: Video;
    resize: boolean;
    rect: DOMRect;
  } | null>(null);
  const [preview, setPreview] = useState<Video | null>(null),
    previewRef = useRef<Video | null>(null);
  const shown = preview || v;
  const showPreview = (next: Video | null) => {
    previewRef.current = next;
    setPreview(next);
  };
  useEffect(() => {
    if (!playing) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    setError('');
    setReady(false);
    setBlocked(false);
    void loadApi()
      .then((YT) => {
        if (cancelled || !host.current) return;
        const el = document.createElement('div');
        host.current.append(el);
        timer = setTimeout(
          () =>
            setError(
              'プレーヤーから応答がありません。通信環境を確認するか、代替リンクを開いてください。',
            ),
          18000,
        );
        player.current = new YT.Player(el, {
          host: 'https://www.youtube-nocookie.com',
          videoId: v.videoId,
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, controls: 1, rel: 0, origin: location.origin },
          events: {
            onReady: () => {
              if (cancelled) return;
              clearTimeout(timer);
              setReady(true);
              const iframe = player.current?.getIframe();
              if (iframe) {
                iframe.title = 'YouTube動画';
                iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
                iframe.referrerPolicy = 'strict-origin-when-cross-origin';
              }
              player.current?.playVideo();
            },
            onError: (e: { data: number }) => {
              if (cancelled) return;
              clearTimeout(timer);
              setError(
                (
                  {
                    2: '動画URLが無効です。',
                    5: 'このブラウザで再生できません。',
                    100: '動画が削除されたか非公開です。',
                    101: 'この動画は埋め込み再生が許可されていません。',
                    150: 'この動画は埋め込み再生が許可されていません。',
                    153: 'YouTubeが再生元を確認できませんでした。広告・追跡ブロックやリファラー設定を確認してください。',
                  } as Record<number, string>
                )[e.data] || `再生できませんでした（${e.data}）。`,
              );
            },
            onAutoplayBlocked: () => setBlocked(true),
            onStateChange: (e: { data: number }) => {
              if (!cancelled) {
                setPlaybackState(e.data);
                if (e.data === 1) setBlocked(false);
              }
            },
          },
        });
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      player.current?.destroy();
      player.current = undefined;
      host.current?.replaceChildren();
    };
  }, [playing, v.videoId]);
  return (
    <div
      className={`video-box ${playing ? 'playing' : ''} ${editing ? 'editable' : ''}`}
      data-testid="video-box"
      data-player-state={playbackState}
      style={{
        left: `${(shown.x / page.width) * 100}%`,
        top: `${(shown.y / page.height) * 100}%`,
        width: `${(shown.width / page.width) * 100}%`,
        height: `${(shown.height / page.height) * 100}%`,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {playing ? (
        <>
          <div ref={host} className="player-host" />
          {!ready && !error && <span className="video-loading">YouTubeに接続中…</span>}
          {blocked && !error && <span className="video-hint">動画内の ▶ をタップしてください</span>}
          {error && (
            <div className="video-error">
              <p>{error}</p>
              <a
                href={`https://www.youtube.com/watch?v=${v.videoId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                YouTubeで開く <ExternalLink size={14} />
              </a>
            </div>
          )}
          <button className="video-close" title="動画を閉じる" onClick={() => setPlaying(false)}>
            <X size={18} />
          </button>
        </>
      ) : (
        <button
          className="video-thumbnail"
          aria-label="動画をページ内で再生"
          onClick={() => setPlaying(true)}
        >
          <img
            src={`https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`}
            alt="YouTube動画のサムネイル"
            draggable={false}
            onError={(e) => {
              e.currentTarget.style.visibility = 'hidden';
            }}
          />
          <span className="play-badge">
            <Play fill="currentColor" size={24} />
          </span>
          <span className="video-label">
            YouTube <span>ページ内で再生</span>
          </span>
        </button>
      )}
      {editing && !playing && (
        <>
          <div
            className="video-handle"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = {
                x: e.clientX,
                y: e.clientY,
                video: v,
                resize: false,
                rect: e.currentTarget.closest('.pdf-page')!.getBoundingClientRect(),
              };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              showPreview({
                ...d.video,
                x: clamp(
                  d.video.x + ((e.clientX - d.x) * page.width) / d.rect.width,
                  0,
                  page.width - d.video.width,
                ),
                y: clamp(
                  d.video.y + ((e.clientY - d.y) * page.height) / d.rect.height,
                  0,
                  page.height - d.video.height,
                ),
              });
            }}
            onPointerUp={() => {
              if (previewRef.current) onChange(previewRef.current);
              showPreview(null);
              drag.current = null;
            }}
            onPointerCancel={() => {
              showPreview(null);
              drag.current = null;
            }}
          >
            <GripHorizontal size={16} />
            <span>移動</span>
            <button
              title="動画を削除"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onDelete}
            >
              <Trash2 size={15} />
            </button>
          </div>
          <button
            className="video-resize"
            title="動画のサイズ変更"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = {
                x: e.clientX,
                y: e.clientY,
                video: v,
                resize: true,
                rect: e.currentTarget.closest('.pdf-page')!.getBoundingClientRect(),
              };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              showPreview({
                ...d.video,
                width: clamp(
                  d.video.width + ((e.clientX - d.x) * page.width) / d.rect.width,
                  Math.min(220, page.width - d.video.x),
                  page.width - d.video.x,
                ),
                height: clamp(
                  d.video.height + ((e.clientY - d.y) * page.height) / d.rect.height,
                  Math.min(160, page.height - d.video.y),
                  page.height - d.video.y,
                ),
              });
            }}
            onPointerUp={() => {
              if (previewRef.current) onChange(previewRef.current);
              showPreview(null);
              drag.current = null;
            }}
            onPointerCancel={() => {
              showPreview(null);
              drag.current = null;
            }}
          >
            <Maximize2 size={17} />
          </button>
        </>
      )}
    </div>
  );
}
