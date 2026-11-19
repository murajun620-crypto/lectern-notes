import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play,
  X,
  GripHorizontal,
  ExternalLink,
  Trash2,
  Maximize2,
  Minimize2,
  Minus,
  RotateCw,
} from 'lucide-react';
import type { Video, Page } from './model';
import {
  enlargedVideoRect,
  playerViewport,
  positionVideo,
  resizeVideo,
  rotateVideo,
} from './video-layout';
import type { VideoBounds } from './video-layout';

export type PlaybackActions = {
  enlarged: boolean;
  canResize: boolean;
  toggleSize: () => void;
  close: () => void;
};
export type RegisterLecturePlayback = (key: string, actions: PlaybackActions | null) => void;

export function PlaybackButtons({ actions }: { actions: PlaybackActions }) {
  const { enlarged, canResize, toggleSize, close } = actions;
  return (
    <>
      {canResize && (
        <button
          type="button"
          title={enlarged ? '配置サイズに戻す' : '動画を拡大'}
          onClick={toggleSize}
        >
          {enlarged ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      )}
      <button type="button" title="動画を閉じる" onClick={close}>
        <X size={18} />
      </button>
    </>
  );
}

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
  lecture,
  registerLecturePlayback,
  pageScale,
  displayZoom = 1,
  visibleBounds,
  onChange,
  onDelete,
}: {
  video: Video;
  page: Page;
  editing: boolean;
  lecture: boolean;
  registerLecturePlayback: RegisterLecturePlayback;
  pageScale: number;
  displayZoom?: number;
  visibleBounds: VideoBounds;
  onChange: (v: Video) => void;
  onDelete: () => void;
}) {
  const [playing, setPlaying] = useState(false),
    [enlarged, setEnlarged] = useState(false),
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
    rect: DOMRect;
  } | null>(null);
  const [preview, setPreview] = useState<Video | null>(null),
    previewRef = useRef<Video | null>(null);
  const larger = playing ? enlargedVideoRect(v, page, pageScale * displayZoom, visibleBounds) : v;
  const shown = playing && enlarged ? larger : preview || v;
  const canResize = (enlarged || larger.width > v.width + 0.01) && !error;
  const toggleSize = useCallback(() => setEnlarged((value) => !value), []);
  const close = useCallback(() => {
    setPlaying(false);
    setEnlarged(false);
  }, []);
  const playbackKey = `${page.id}:${v.id}`;
  useEffect(() => {
    if (!lecture || !playing) return;
    registerLecturePlayback(playbackKey, { enlarged, canResize, toggleSize, close });
    return () => registerLecturePlayback(playbackKey, null);
  }, [
    lecture,
    playing,
    playbackKey,
    enlarged,
    canResize,
    toggleSize,
    close,
    registerLecturePlayback,
  ]);
  const compact = shown.width * pageScale * displayZoom < 180;
  const align =
    shown.x + shown.width / 2 > (visibleBounds.left + visibleBounds.right) / 2 ? 'right' : 'left';
  const actionsBelow = (shown.y - visibleBounds.top) * pageScale < 30;
  const statusAbove = shown.y - visibleBounds.top > visibleBounds.bottom - shown.y - shown.height;
  const statusBesideActions = !lecture && statusAbove !== actionsBelow;
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
    setPlaybackState(-1);
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
      className={`video-box ${playing ? 'playing' : ''} ${editing ? 'editable' : ''} ${compact ? 'compact' : ''}`}
      data-testid="video-box"
      data-player-state={playbackState}
      style={{
        left: `${(shown.x / page.width) * 100}%`,
        top: `${(shown.y / page.height) * 100}%`,
        width: `${(shown.width / page.width) * 100}%`,
        height: `${(shown.height / page.height) * 100}%`,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onLostPointerCapture={() => {
        showPreview(null);
        drag.current = null;
      }}
    >
      {playing ? (
        <>
          <div
            ref={host}
            className="player-host"
            style={playerViewport(shown, pageScale, displayZoom)}
          />
          {!lecture && (
            <div className={`video-playback-actions ${align} ${actionsBelow ? 'below' : ''}`}>
              <PlaybackButtons actions={{ enlarged, canResize, toggleSize, close }} />
            </div>
          )}
          {(error || blocked || !ready) && (
            <div
              className={`video-status ${align} ${statusAbove ? 'above' : ''} ${statusBesideActions ? 'with-actions' : ''}`}
            >
              {error ? (
                <div className="video-error" role="alert">
                  <p>{error}</p>
                  <a
                    href={`https://www.youtube.com/watch?v=${v.videoId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    YouTubeで開く <ExternalLink size={14} />
                  </a>
                </div>
              ) : (
                <span role="status">
                  {blocked ? '動画内の ▶ をタップしてください' : 'YouTubeに接続中…'}
                </span>
              )}
            </div>
          )}
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
                rect: e.currentTarget.closest('[data-video-paper]')!.getBoundingClientRect(),
              };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              showPreview(
                positionVideo(
                  d.video,
                  page,
                  d.video.x + ((e.clientX - d.x) * page.width) / d.rect.width,
                  d.video.y + ((e.clientY - d.y) * page.height) / d.rect.height,
                ),
              );
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
              title={v.width >= v.height ? '動画を縦長にする' : '動画を横長にする'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onChange(rotateVideo(v, page))}
            >
              <RotateCw size={15} />
            </button>
            <button
              title="サムネイルを小さく"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onChange(resizeVideo(v, page, 0.7))}
            >
              <Minus size={15} />
            </button>
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
                rect: e.currentTarget.closest('[data-video-paper]')!.getBoundingClientRect(),
              };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const dx = ((e.clientX - d.x) * page.width) / d.rect.width;
              const dy = ((e.clientY - d.y) * page.height) / d.rect.height;
              const { width, height } = d.video;
              const factor = 1 + (dx * width + dy * height) / (width ** 2 + height ** 2);
              showPreview(resizeVideo(d.video, page, factor));
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
