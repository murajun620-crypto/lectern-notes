import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  PanelTopClose,
  PanelTopOpen,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { Video, Page } from './model';
import { clamp } from './model';
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
  muted: boolean | null;
  toggleMute: () => void;
  close: () => void;
};
export type RegisterPlayback = (key: string, actions: PlaybackActions | null) => void;

export function PlaybackButtons({ actions }: { actions: PlaybackActions }) {
  const { enlarged, canResize, toggleSize, muted, toggleMute, close } = actions;
  const audioLabel = muted ? '動画のミュートを解除' : '動画をミュート';
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
      {muted !== null && (
        <button type="button" title={audioLabel} aria-label={audioLabel} onClick={toggleMute}>
          {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
      )}
      <button
        type="button"
        className="video-close"
        title="動画を閉じる"
        aria-label="動画を閉じる"
        onClick={close}
      >
        <X size={18} />
        閉じる
      </button>
    </>
  );
}

type Player = {
  destroy(): void;
  playVideo(): void;
  pauseVideo(): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
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
  selected,
  playing,
  playbackKey,
  controls,
  onSelect,
  onDeselect,
  onPlay,
  onClosePlayback,
  registerPlayback,
  pageScale,
  displayZoom = 1,
  visibleBounds,
  onChange,
  onDelete,
}: {
  video: Video;
  page: Page;
  selected: boolean;
  playing: boolean;
  playbackKey: string;
  controls: HTMLDivElement | null;
  onSelect: () => void;
  onDeselect: () => void;
  onPlay: () => void;
  onClosePlayback: (key: string) => void;
  registerPlayback: RegisterPlayback;
  pageScale: number;
  displayZoom?: number;
  visibleBounds: VideoBounds;
  onChange: (v: Video) => void;
  onDelete: () => void;
}) {
  const [enlarged, setEnlarged] = useState(false),
    [error, setError] = useState(''),
    [blocked, setBlocked] = useState(false),
    [muted, setMuted] = useState<boolean | null>(null),
    [playbackState, setPlaybackState] = useState(-1);
  const box = useRef<HTMLDivElement>(null),
    host = useRef<HTMLDivElement>(null),
    player = useRef<Player | undefined>(undefined);
  const drag = useRef<{
    x: number;
    y: number;
    video: Video;
    rect: DOMRect;
  } | null>(null);
  const [preview, setPreview] = useState<Video | null>(null),
    previewRef = useRef<Video | null>(null);
  const scale = pageScale * displayZoom;
  const larger = playing ? enlargedVideoRect(v, page, scale, visibleBounds) : v;
  const collapsed = v.collapsed && !playing;
  const placement = preview ?? v;
  const collapsedSize = 44 / scale;
  const shown = collapsed
    ? { ...placement, width: collapsedSize, height: collapsedSize }
    : playing && enlarged
      ? larger
      : placement;
  const canResize = (enlarged || larger.width > v.width + 0.01) && !error;
  const toggleSize = useCallback(() => setEnlarged((value) => !value), []);
  const toggleMute = useCallback(() => {
    if (!player.current || muted === null) return;
    if (muted) player.current.unMute();
    else player.current.mute();
    setMuted(!muted);
  }, [muted]);
  const close = useCallback(() => onClosePlayback(playbackKey), [playbackKey, onClosePlayback]);
  const compact = shown.width * scale < 180;
  const align =
    shown.x + shown.width / 2 > (visibleBounds.left + visibleBounds.right) / 2 ? 'right' : 'left';
  const statusAbove = shown.y - visibleBounds.top > visibleBounds.bottom - shown.y - shown.height;
  const editWidth = collapsed ? 108 : 176;
  const editHeight = 36;
  const screenWidth = (visibleBounds.right - visibleBounds.left) * scale;
  const screenHeight = (visibleBounds.bottom - visibleBounds.top) * scale;
  const left = (shown.x - visibleBounds.left) * scale;
  const top = (shown.y - visibleBounds.top) * scale;
  const right = left + shown.width * scale;
  const bottom = top + shown.height * scale;
  // On a small thumbnail the corner handle can cover the central play button.
  const handleSize = 28;
  let handleLeft = right - handleSize;
  if (Math.min(right - left, bottom - top) < 2 * handleSize) {
    handleLeft = right + 4 + handleSize <= screenWidth ? right + 4 : left - 4 - handleSize;
  }
  const onScreen = right > 0 && left < screenWidth && bottom > 0 && top < screenHeight;
  const alignX = (width: number) =>
    Math.round(
      clamp(align === 'right' ? right - width : left, 4, Math.max(4, screenWidth - width - 4)),
    );
  const menuY = Math.round(
    clamp(
      top >= editHeight + 8 ? top - editHeight - 4 : bottom + 4,
      4,
      Math.max(4, screenHeight - editHeight - 4),
    ),
  );
  const audioState = error ? null : muted;
  const playbackWidth = 84 + (canResize ? 44 : 0) + (audioState !== null ? 44 : 0);
  const playbackHeight = 44;
  const playbackY = top >= playbackHeight + 10 ? top - playbackHeight - 6 : bottom + 6;
  const showLocalPlayback =
    !!controls &&
    onScreen &&
    screenWidth >= playbackWidth + 8 &&
    playbackY + playbackHeight <= screenHeight - 4;
  useEffect(() => {
    if (!playing || showLocalPlayback) return;
    registerPlayback(playbackKey, {
      enlarged,
      canResize,
      toggleSize,
      muted: audioState,
      toggleMute,
      close,
    });
    return () => registerPlayback(playbackKey, null);
  }, [
    playing,
    showLocalPlayback,
    playbackKey,
    enlarged,
    canResize,
    toggleSize,
    audioState,
    toggleMute,
    close,
    registerPlayback,
  ]);
  const startPlayback = () => {
    onDeselect();
    setEnlarged(false);
    setMuted(null);
    setPlaybackState(-1);
    onPlay();
  };
  const playSize =
    Math.min(compact ? 29 : 44, shown.width * scale * 0.68, shown.height * scale * 0.68) /
    displayZoom;
  const badgeStyle = { width: playSize, height: playSize };
  const showPreview = (next: Video | null) => {
    previewRef.current = next;
    setPreview(next);
  };
  useEffect(() => {
    if (!playing) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      audioPoll: ReturnType<typeof setInterval> | undefined;
    setError('');
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
            onReady: ({ target }: { target: Player }) => {
              if (cancelled) return;
              clearTimeout(timer);
              const iframe = target.getIframe();
              if (iframe) {
                iframe.title = 'YouTube動画';
                iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
                iframe.referrerPolicy = 'strict-origin-when-cross-origin';
              }
              target.mute();
              setMuted(true);
              target.playVideo();
              // YouTube has no mute-change event. Reflect changes from its own controls.
              audioPoll = setInterval(() => {
                const value = target.isMuted();
                if (typeof value === 'boolean') setMuted(value);
              }, 500);
            },
            onError: (e: { data: number }) => {
              if (cancelled) return;
              clearTimeout(timer);
              clearInterval(audioPoll);
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
              if (cancelled) return;
              if (e.data === 0) {
                close();
                return;
              }
              setPlaybackState(e.data);
              if (e.data === 1) setBlocked(false);
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
      clearInterval(audioPoll);
      player.current?.destroy();
      player.current = undefined;
      host.current?.replaceChildren();
    };
  }, [playing, v.videoId, close]);
  return (
    <div
      ref={box}
      className={`video-box ${playing ? 'playing' : ''} ${selected ? 'selected' : ''} ${collapsed ? 'collapsed' : ''}`}
      data-testid="video-box"
      data-player-state={playing ? playbackState : -1}
      style={{
        left: `${(shown.x / page.width) * 100}%`,
        top: `${(shown.y / page.height) * 100}%`,
        width: `${(shown.width / page.width) * 100}%`,
        height: `${(shown.height / page.height) * 100}%`,
        outlineWidth: selected ? 1 / displayZoom : undefined,
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
          {(error || blocked) && (
            <div className={`video-status ${align} ${statusAbove ? 'above' : ''}`}>
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
                <span role="status">動画内の ▶ をタップしてください</span>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <button
            type="button"
            className="video-thumbnail"
            aria-label="サムネイルを選択"
            aria-pressed={selected}
            onClick={onSelect}
          >
            {!collapsed && (
              <img
                src={`https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`}
                alt="YouTube動画のサムネイル"
                draggable={false}
                onError={(e) => {
                  e.currentTarget.style.visibility = 'hidden';
                }}
              />
            )}
          </button>
          <button
            type="button"
            className="play-badge"
            style={badgeStyle}
            aria-label="動画をページ内で再生"
            title="動画をページ内で再生"
            onClick={startPlayback}
          >
            <Play fill="currentColor" />
          </button>
        </>
      )}
      {playing &&
        showLocalPlayback &&
        controls &&
        createPortal(
          <div
            className="video-playback-actions"
            data-video-control=""
            role="group"
            aria-label="動画の再生操作"
            style={{
              left: alignX(playbackWidth),
              top: Math.round(playbackY),
              width: playbackWidth,
            }}
          >
            <PlaybackButtons
              actions={{ enlarged, canResize, toggleSize, muted: audioState, toggleMute, close }}
            />
          </div>,
          controls,
        )}
      {selected &&
        !playing &&
        onScreen &&
        controls &&
        createPortal(
          <>
            <div
              className="video-handle"
              data-video-control=""
              style={{
                left: alignX(editWidth),
                top: menuY,
                width: editWidth,
                height: editHeight,
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = {
                  x: e.clientX,
                  y: e.clientY,
                  video: v,
                  rect: box.current!.closest('[data-video-paper]')!.getBoundingClientRect(),
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
              <span className="video-grip" title="動画を移動">
                <GripHorizontal size={18} />
              </span>
              {!collapsed && (
                <>
                  <button
                    title={v.width >= v.height ? '動画を縦長にする' : '動画を横長にする'}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onChange(rotateVideo(v, page))}
                  >
                    <RotateCw size={17} />
                  </button>
                  <button
                    title="サムネイルを小さく"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => onChange(resizeVideo(v, page, 0.7))}
                  >
                    <Minus size={17} />
                  </button>
                </>
              )}
              <button
                type="button"
                title={collapsed ? '折りたたみを解除' : '動画を折りたたむ'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onChange({ ...v, collapsed: !v.collapsed })}
              >
                {collapsed ? <PanelTopOpen size={17} /> : <PanelTopClose size={17} />}
              </button>
              <button
                title="動画を削除"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  onDeselect();
                  onDelete();
                }}
              >
                <Trash2 size={17} />
              </button>
            </div>
            <button
              className="video-resize"
              data-video-control=""
              style={{
                left: Math.round(clamp(handleLeft, 0, screenWidth - handleSize)),
                top: Math.round(clamp(bottom - handleSize, 0, screenHeight - handleSize)),
              }}
              hidden={collapsed}
              title="動画のサイズ変更"
              onPointerDown={(e) => {
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = {
                  x: e.clientX,
                  y: e.clientY,
                  video: v,
                  rect: box.current!.closest('[data-video-paper]')!.getBoundingClientRect(),
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
              <Maximize2 size={15} />
            </button>
          </>,
          controls,
        )}
    </div>
  );
}
