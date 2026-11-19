import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eraser,
  FilePlus2,
  FileText,
  FolderOpen,
  Hand,
  Highlighter,
  LayoutGrid,
  Loader2,
  Maximize,
  Minimize,
  MoreHorizontal,
  MousePointer2,
  PenLine,
  Plus,
  Redo2,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Video,
  X,
  CircleHelp,
  HardDrive,
  ArrowUpRight,
} from 'lucide-react';
import type { Page, Project, Stroke, Tool } from './model';
import { blankPage, clamp, drawStrokes, parseYoutubeUrl, uid } from './model';
import {
  deleteProject,
  download,
  exportBackup,
  importBackup,
  listProjects,
  saveProject,
} from './storage';
import { demoFile, exportPdf, importPdf, releasePdfs, renderPage } from './pdf';
import Stage from './Stage';
import { createInkPriority, highlighterWidths, loadInputPreferences, penWidths } from './input';
import type { PencilTool } from './input';
import { initialVideoRect } from './video-layout';
import { PlaybackButtons } from './VideoBox';
import type { PlaybackActions, RegisterPlayback } from './VideoBox';
import { pageZoomSteps } from './usePageViewport';
import UpdateButton from './UpdateButton';
import { useFullscreen } from './useFullscreen';
function IconButton({
  label,
  children,
  onClick,
  active,
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`icon-button ${active ? 'active' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-top">
        <h2>{title}</h2>
        <IconButton label="閉じる" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
      {children}
    </dialog>
  );
}
const Thumbnail = memo(function Thumbnail({
  page,
  shouldPause,
}: {
  page: Page;
  shouldPause?: () => boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [background, setBackground] = useState<HTMLCanvasElement | null>(null);
  const { width, height, sourcePage, assetId, strokes } = page;
  const scale = 160 / width;
  useEffect(() => {
    const abort = new AbortController();
    const canvas = ref.current!;
    setBackground(null);
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      observer.disconnect();
      const temp = document.createElement('canvas');
      void renderPage(
        { width, height, sourcePage, assetId },
        temp,
        scale,
        abort.signal,
        undefined,
        shouldPause,
      )
        .then(() => {
          if (!abort.signal.aborted) setBackground(temp);
        })
        .catch(() => {});
    });
    observer.observe(canvas);
    return () => {
      abort.abort();
      observer.disconnect();
    };
  }, [width, height, sourcePage, assetId, scale, shouldPause]);
  useEffect(() => {
    const canvas = ref.current!;
    if (!background) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number;
    const paint = () => {
      if (shouldPause?.()) {
        timer = setTimeout(() => {
          frame = requestAnimationFrame(paint);
        }, 95);
        return;
      }
      if (canvas.width !== background.width) canvas.width = background.width;
      if (canvas.height !== background.height) canvas.height = background.height;
      const ctx = canvas.getContext('2d')!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(background, 0, 0);
      ctx.save();
      ctx.scale(scale, scale);
      drawStrokes(ctx, strokes);
      ctx.restore();
    };
    frame = requestAnimationFrame(paint);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [background, scale, strokes, shouldPause]);
  return <canvas ref={ref} style={{ aspectRatio: `${page.width}/${page.height}` }} />;
});
const tools: { id: Tool; label: string; icon: ReactNode; key: string }[] = [
  { id: 'hand', label: '移動', icon: <Hand />, key: 'H' },
  { id: 'pen', label: 'ペン', icon: <PenLine />, key: 'P' },
  { id: 'highlighter', label: '蛍光ペン', icon: <Highlighter />, key: 'M' },
  { id: 'eraser', label: '消しゴム', icon: <Eraser />, key: 'E' },
  { id: 'select', label: '選択', icon: <MousePointer2 />, key: 'S' },
  { id: 'laser', label: 'レーザー', icon: <Sparkles />, key: 'L' },
];
const inkPalettes = {
  pen: { label: 'ペン', preference: 'presets', widthPreference: 'penWidth', widths: penWidths },
  highlighter: {
    label: '蛍光ペン',
    preference: 'highlighterPresets',
    widthPreference: 'highlighterWidth',
    widths: highlighterWidths,
  },
} as const;
type WritingTool = keyof typeof inkPalettes;
type Dialog =
  | { kind: 'rename'; id: string; value: string }
  | { kind: 'delete'; id: string; name: string }
  | { kind: 'deletePage'; id: string }
  | { kind: 'video' }
  | { kind: 'help' }
  | null;
export default function App() {
  const [projects, setProjects] = useState<Project[]>([]),
    [project, setProject] = useState<Project | null>(null),
    [initialized, setInitialized] = useState(false);
  const [inkClipboard, setInkClipboard] = useState<Stroke[]>([]);
  const [inkPriority] = useState(createInkPriority);
  const [tool, setTool] = useState<Tool>('pen'),
    [colorChoices, setColorChoices] = useState<Record<WritingTool, number | string>>({
      pen: 0,
      highlighter: 0,
    }),
    [preferences, setPreferences] = useState(loadInputPreferences),
    [trail, setTrail] = useState(true),
    [zoom, setZoom] = useState(1),
    [fitWidth, setFitWidth] = useState(false),
    [sidebar, setSidebar] = useState(true),
    [fullscreenSidebar, setFullscreenSidebar] = useState(false),
    [documentTools, setDocumentTools] = useState(false);
  const { fullscreen, toggleFullscreen, exitFullscreen } = useFullscreen();
  const showSidebar = fullscreen ? fullscreenSidebar : sidebar;
  const [videoPlayback, setVideoPlayback] = useState<Record<string, PlaybackActions>>({});
  const registerPlayback = useCallback<RegisterPlayback>((key, actions) => {
    setVideoPlayback((current) => {
      if (actions) return { ...current, [key]: actions };
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);
  const fingerInk = preferences.fingerInk;
  const pencilTool = useRef<PencilTool>('pen'),
    lastWritingTool = useRef<WritingTool>('pen');
  if (tool !== 'hand') pencilTool.current = tool;
  if (tool === 'pen' || tool === 'highlighter') lastWritingTool.current = tool;
  const writingTool = lastWritingTool.current;
  const palette = inkPalettes[writingTool];
  const width = preferences[palette.widthPreference];
  const presets = preferences[palette.preference];
  const colorChoice = colorChoices[writingTool];
  const color = typeof colorChoice === 'number' ? presets[colorChoice] : colorChoice;
  const chooseColor = (choice: number | string) =>
    setColorChoices((current) => ({ ...current, [writingTool]: choice }));
  const widthTool = tool === 'hand' ? pencilTool.current : tool;
  const toolWidth =
    widthTool === 'laser'
      ? preferences.laserWidth
      : widthTool === 'eraser'
        ? preferences.eraserWidth
        : width;
  const widthLabel =
    widthTool === 'laser'
      ? 'レーザーの太さ'
      : widthTool === 'eraser'
        ? '消しゴムのサイズ'
        : `${palette.label}の太さ`;
  const widthOptions =
    widthTool === 'laser'
      ? [2, 4, 6, 8, 12]
      : widthTool === 'eraser'
        ? [8, 16, 28, 48, 80]
        : palette.widths;
  const toggleEraser = useCallback(
    () =>
      setTool((current) =>
        (current === 'hand' ? pencilTool.current : current) === 'eraser'
          ? lastWritingTool.current
          : 'eraser',
      ),
    [],
  );
  useEffect(() => {
    try {
      localStorage.setItem('lectern.input', JSON.stringify(preferences));
    } catch {
      /* Preferences are optional; project data still uses IndexedDB. */
    }
  }, [preferences]);
  useEffect(() => {
    const resize = () =>
      document.documentElement.style.setProperty(
        '--app-height',
        `${window.visualViewport?.height || window.innerHeight}px`,
      );
    resize();
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
    };
  }, []);
  const [dialog, setDialog] = useState<Dialog>(null),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(true),
    [query, setQuery] = useState(''),
    [jump, setJump] = useState('1');
  const [videoUrl, setVideoUrl] = useState(''),
    [videoError, setVideoError] = useState('');
  const input = useRef<HTMLInputElement>(null),
    backupInput = useRef<HTMLInputElement>(null),
    append = useRef(false),
    current = useRef(project);
  current.current = project;
  const history = useRef(new Map<string, { undo: Page[]; redo: Page[] }>());
  const queue = useRef(Promise.resolve()),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const persist = useCallback((p: Project) => {
    queue.current = queue.current.catch(() => {}).then(() => saveProject(p));
    return queue.current
      .then(() => {
        if (current.current === p) setSaved(true);
      })
      .catch((e) => {
        setSaved(false);
        setError(
          `保存できません。空き容量を確認し、バックアップを保存してください。${(e as Error).message}`,
        );
        throw e;
      });
  }, []);
  useEffect(() => {
    void listProjects()
      .then((items) => {
        setProjects(items);
        try {
          const last = items.find((p) => p.id === localStorage.getItem('lectern.active'));
          if (last) setProject(last);
        } catch {
          /* IndexedDB is still usable when localStorage is blocked. */
        }
      })
      .catch(() => setError('保存領域を開けません。Safariの通常ブラウズで開き直してください。'))
      .finally(() => setInitialized(true));
  }, []);
  useEffect(() => {
    if (!project) return;
    setSaved(false);
    const autosave = () => {
      if (inkPriority.isBusy()) saveTimer.current = setTimeout(autosave, 100);
      else void persist(project).catch(() => {});
    };
    saveTimer.current = setTimeout(autosave, 300);
    return () => clearTimeout(saveTimer.current);
  }, [project, persist, inkPriority]);
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden' && current.current) {
        clearTimeout(saveTimer.current);
        void persist(current.current).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [persist]);
  const update = (fn: (p: Project) => Project) => {
    setSaved(false);
    setProject((p) => (p ? { ...fn(p), updatedAt: Date.now() } : p));
  };
  const page = project?.pages[project.currentPage];
  const changePage = useCallback((next: Page) => {
    const p = current.current;
    if (!p) return;
    const prev = p.pages.find((pg) => pg.id === next.id);
    if (!prev) return;
    setSaved(false);
    const h = history.current.get(next.id) || { undo: [], redo: [] };
    h.undo.push(prev);
    if (h.undo.length > 60) h.undo.shift();
    h.redo = [];
    history.current.set(next.id, h);
    setProject({
      ...p,
      updatedAt: Date.now(),
      pages: p.pages.map((pg) => (pg.id === next.id ? next : pg)),
    });
  }, []);
  const navigate = useCallback((delta: number) => {
    setSaved(false);
    setProject((p) =>
      p ? { ...p, currentPage: clamp(p.currentPage + delta, 0, p.pages.length - 1) } : p,
    );
  }, []);
  const focusPage = useCallback((id: string) => {
    setProject((p) => {
      if (!p || p.pages[p.currentPage]?.id === id) return p;
      const currentPage = p.pages.findIndex((item) => item.id === id);
      return currentPage < 0 ? p : { ...p, currentPage };
    });
  }, []);
  const undoRedo = useCallback((redo = false) => {
    const p = current.current;
    if (!p) return;
    const pg = p.pages[p.currentPage],
      h = history.current.get(pg.id);
    if (!h) return;
    const from = redo ? h.redo : h.undo,
      to = redo ? h.undo : h.redo;
    const next = from.pop();
    if (!next) return;
    setSaved(false);
    to.push(pg);
    setProject({
      ...p,
      updatedAt: Date.now(),
      pages: p.pages.map((item) => (item.id === pg.id ? next : item)),
    });
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select,dialog') || busy || dialog)
        return;
      if (e.key === 'Escape') {
        if (fullscreen) exitFullscreen();
        return;
      }
      if (!current.current) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undoRedo(e.shiftKey);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        undoRedo(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        navigate(1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        navigate(-1);
      }
      const t = tools.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (t) setTool(t.id);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undoRedo, navigate, busy, dialog, fullscreen, exitFullscreen]);
  useEffect(() => {
    if (!fullscreen) setDocumentTools(false);
  }, [fullscreen]);
  useEffect(() => setJump(String((project?.currentPage || 0) + 1)), [project?.currentPage]);
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(
        (e as Error).name === 'PasswordException'
          ? 'パスワード保護を解除したPDFを読み込んでください。'
          : (e as Error).message || '処理に失敗しました。',
      );
    } finally {
      setBusy('');
    }
  };
  const open = async (p: Project) => {
    if (current.current) {
      clearTimeout(saveTimer.current);
      await persist(current.current);
    }
    try {
      localStorage.setItem('lectern.active', p.id);
    } catch {
      /* Optional last-opened preference. */
    }
    setProject(p);
    history.current.clear();
    setZoom(1);
    exitFullscreen();
    setTool('pen');
    void navigator.storage?.persist?.().catch(() => {});
  };
  const newFromPdf = async (file: File, adding = false) => {
    const pages = await importPdf(file);
    if (adding && current.current) {
      update((p) => ({ ...p, pages: [...p.pages, ...pages], currentPage: p.pages.length }));
      return;
    }
    const p: Project = {
      id: uid(),
      name: file.name.replace(/\.pdf$/i, '').slice(0, 200),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentPage: 0,
      pages,
    };
    await saveProject(p);
    await open(p);
  };
  const returnLibrary = () =>
    void run('保存中…', async () => {
      if (current.current) {
        clearTimeout(saveTimer.current);
        await persist(current.current);
      }
      try {
        localStorage.removeItem('lectern.active');
      } catch {
        /* Optional last-opened preference. */
      }
      setProject(null);
      exitFullscreen();
      releasePdfs();
      setProjects(await listProjects());
    });
  const backup = () =>
    project &&
    void run('バックアップを作成中…', async () => {
      clearTimeout(saveTimer.current);
      await persist(project);
      download(await exportBackup(project), `${project.name}.lecture.zip`);
    });
  const beforeReload = async () => {
    if (current.current) {
      clearTimeout(saveTimer.current);
      await persist(current.current);
    }
  };
  const exportDocument = () =>
    project &&
    void run('PDFを書き出し中…', async () => {
      download(await exportPdf(project, setBusy), `${project.name}-書き込み.pdf`);
    });
  const addBlank = () => {
    const newPage = blankPage(page?.width, page?.height);
    update((p) => ({
      ...p,
      pages: [...p.pages.slice(0, p.currentPage + 1), newPage, ...p.pages.slice(p.currentPage + 1)],
      currentPage: p.currentPage + 1,
    }));
  };
  const movePage = (index: number, delta: number) =>
    update((p) => {
      const pages = [...p.pages],
        target = clamp(index + delta, 0, pages.length - 1);
      const [pg] = pages.splice(index, 1);
      pages.splice(target, 0, pg);
      return {
        ...p,
        pages,
        currentPage: pages.findIndex((pg) => pg.id === p.pages[p.currentPage].id),
      };
    });
  const insertVideo = (e: FormEvent) => {
    e.preventDefault();
    const source = parseYoutubeUrl(videoUrl);
    if (!source) {
      setVideoError(
        '有効なYouTube URLを入力してください。watch / youtu.be / shortsに対応しています。',
      );
      return;
    }
    if (!page) return;
    changePage({
      ...page,
      videos: [
        ...page.videos,
        {
          id: uid(),
          videoId: source.id,
          ...initialVideoRect(page, source.portrait),
        },
      ],
    });
    setDialog(null);
    setTool('hand');
  };
  const h = page ? history.current.get(page.id) : undefined;
  const visibleProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div
      className={`app ${project ? 'editor' : 'library'} ${fullscreen ? 'is-fullscreen' : ''}`}
      onClick={(e) => {
        const target = e.target as Element;
        for (const menu of document.querySelectorAll('details[open]'))
          if (
            target.closest('summary') !== menu.querySelector('summary') &&
            (!menu.contains(target) || target.closest('.dropdown button'))
          )
            (menu as HTMLDetailsElement).open = false;
      }}
    >
      <input
        hidden
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void run('PDFを読み込み中…', () => newFromPdf(file, append.current));
        }}
      />
      <input
        hidden
        ref={backupInput}
        type="file"
        accept=".zip,.lecture.zip"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file)
            void run('バックアップを復元中…', async () => {
              const p = await importBackup(file);
              setProjects(await listProjects());
              await open(p);
            });
        }}
      />
      {!project ? (
        <>
          <aside className="library-nav">
            <div className="wordmark">
              <span className="brand-symbol">
                <BookOpen size={24} />
              </span>
              lectern<span className="brand-dot">.</span>
            </div>
            <p className="nav-caption">TEACHING WORKSPACE</p>
            <div className="nav-item selected">
              <FolderOpen size={19} /> マイライブラリ <span>{projects.length}</span>
            </div>
            <div className="nav-bottom">
              <div className="local-badge">
                <HardDrive size={18} />
                <div>
                  このデバイスに保存<small>PDFもノートも、あなたの手元に</small>
                </div>
              </div>
              <button className="nav-help" onClick={() => setDialog({ kind: 'help' })}>
                <CircleHelp size={18} /> 使い方と保存について <ArrowUpRight size={15} />
              </button>
            </div>
          </aside>
          <main className="library-main">
            <header className="library-header">
              <span>
                マイライブラリ <span className="subtle">/ LECTURES</span>
              </span>
              <div className="library-header-end">
                <UpdateButton beforeReload={beforeReload} />
                <span className="local-label">
                  <span /> ローカルワークスペース
                </span>
              </div>
            </header>
            <section className="library-intro">
              <div>
                <div className="eyebrow">LESS FRICTION. MORE TEACHING.</div>
                <h1>講義を、ひとつの画面に。</h1>
                <p>
                  PDFに書く。動画で伝える。ポインターで導く。
                  <br />
                  いつもの教材を、あなたらしい授業へ。
                </p>
              </div>
              <div className="intro-art" aria-hidden="true">
                <div className="art-sheet">
                  <span>Ideas worth sharing.</span>
                  <i />
                  <i />
                  <i />
                  <b>✳</b>
                </div>
                <div className="art-pen" />
                <div className="art-play">
                  <PlayIcon />
                </div>
              </div>
            </section>
            <div className="library-actions">
              <div className="section-title">
                <h2>講義資料</h2>
                <span>{projects.length} 件の資料</span>
              </div>
              <div className="action-group">
                <button className="secondary" onClick={() => backupInput.current?.click()}>
                  <Upload size={17} /> バックアップを復元
                </button>
                <button
                  className="primary"
                  onClick={() => {
                    append.current = false;
                    input.current?.click();
                  }}
                >
                  <Plus size={19} /> PDFを読み込む
                </button>
              </div>
            </div>
            {projects.length > 0 && (
              <label className="search">
                <Search size={18} />
                <input
                  placeholder="資料を検索"
                  aria-label="資料を検索"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            )}
            {!initialized ? (
              <div className="empty-state">
                <Loader2 className="spin" /> ライブラリを読み込み中…
              </div>
            ) : projects.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">
                  <FileText size={36} strokeWidth={1.3} />
                  <Plus size={16} />
                </div>
                <h3>最初の講義を、ここから。</h3>
                <p>
                  PDFを読み込んで、Pencilで書き込みましょう。
                  <br />
                  教材はこのブラウザに自動で保存されます。
                </p>
                <button
                  className="primary"
                  onClick={() => {
                    append.current = false;
                    input.current?.click();
                  }}
                >
                  <FolderOpen size={18} /> PDFを選ぶ
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    void run('サンプルを準備中…', async () => newFromPdf(await demoFile()))
                  }
                >
                  まずは3ページのサンプルで試す <ChevronRight size={16} />
                </button>
              </div>
            ) : (
              <div className="project-grid">
                {visibleProjects.map((p) => (
                  <article key={p.id} className="project-card">
                    <button
                      className="project-open"
                      onClick={() => void run('資料を開いています…', () => open(p))}
                    >
                      <div className="project-cover">
                        <Thumbnail page={p.pages[0]} />
                        <span>{p.pages.length} PAGES</span>
                      </div>
                      <h3>{p.name}</h3>
                      <p>
                        {new Date(p.updatedAt).toLocaleDateString('ja-JP')} 更新 <span>·</span>{' '}
                        {p.pages.length}ページ
                      </p>
                    </button>
                    <details className="card-menu">
                      <summary aria-label={`${p.name}のメニュー`}>
                        <MoreHorizontal size={20} />
                      </summary>
                      <div className="dropdown">
                        <button
                          onClick={() => setDialog({ kind: 'rename', id: p.id, value: p.name })}
                        >
                          <PenLine size={16} /> 名前を変更
                        </button>
                        <button
                          onClick={() =>
                            void run('複製中…', async () => {
                              await saveProject({
                                ...structuredClone(p),
                                id: uid(),
                                name: `${p.name.slice(0, 190)} のコピー`,
                                createdAt: Date.now(),
                                updatedAt: Date.now(),
                              });
                              setProjects(await listProjects());
                            })
                          }
                        >
                          <Copy size={16} /> 複製
                        </button>
                        <button
                          className="danger"
                          onClick={() => setDialog({ kind: 'delete', id: p.id, name: p.name })}
                        >
                          <Trash2 size={16} /> 削除
                        </button>
                      </div>
                    </details>
                  </article>
                ))}
                {!visibleProjects.length && <p className="subtle">該当する資料がありません。</p>}
              </div>
            )}
            <footer className="library-footer">
              <span>
                <CheckCircle2 size={15} /> アカウント不要で、すぐに使えます
              </span>
              <span>Made for your next great lecture.</span>
            </footer>
          </main>
        </>
      ) : (
        <>
          {(!fullscreen || documentTools) && (
            <header className="editor-header" id="document-tools">
              <IconButton label="ライブラリに戻る" onClick={returnLibrary}>
                <ArrowLeft size={21} />
              </IconButton>
              <span className="small-brand">
                <BookOpen size={21} />
              </span>
              <button
                className="document-title"
                title="資料名を変更"
                onClick={() => setDialog({ kind: 'rename', id: project.id, value: project.name })}
              >
                {project.name}
                <span>⌄</span>
              </button>
              <span className={`save-status ${saved ? '' : 'saving'}`}>
                {saved ? <Check size={14} /> : <Loader2 size={14} className="spin" />}
                {saved ? '保存済み' : '保存中'}
              </span>
              <div className="header-end">
                <UpdateButton beforeReload={beforeReload} />
                <details className="export-menu">
                  <summary className="secondary">
                    <Download size={17} />
                    <span>書き出す</span>
                  </summary>
                  <div className="dropdown">
                    <button onClick={backup}>
                      <Download size={17} /> 編集可能なバックアップ
                    </button>
                    <button onClick={exportDocument}>
                      <FileText size={17} /> 書き込み入りPDF
                    </button>
                    <button
                      onClick={() => {
                        append.current = true;
                        input.current?.click();
                      }}
                    >
                      <FilePlus2 size={17} /> PDFのページを追加
                    </button>
                    <button onClick={() => setDialog({ kind: 'help' })}>
                      <CircleHelp size={17} /> 使い方と保存について
                    </button>
                  </div>
                </details>
              </div>
            </header>
          )}
          <div className="toolbar">
            <div className="tool-group">
              {tools.map((t) => (
                <button
                  key={t.id}
                  className={`tool-button ${tool === t.id ? 'active' : ''}`}
                  title={`${t.label} (${t.key})`}
                  aria-label={t.label}
                  aria-pressed={tool === t.id}
                  onClick={() => setTool(t.id)}
                >
                  {t.icon}
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
            <div className="toolbar-divider" />
            <button
              className="tool-button video-insert"
              onClick={() => {
                setVideoUrl('');
                setVideoError('');
                setDialog({ kind: 'video' });
              }}
              title="YouTube動画を挿入"
              aria-label="YouTube挿入"
            >
              <Video />
              <span>動画を挿入</span>
            </button>
            <div className="toolbar-divider" />
            <div className="ink-settings">
              <label className="color-picker" title={`${palette.label}の色`}>
                <input
                  type="color"
                  aria-label={`${palette.label}の色`}
                  value={color}
                  onChange={(e) => chooseColor(e.target.value)}
                />
                <span style={{ background: color }} />
              </label>
              {presets.map((c, i) => (
                <button
                  key={i}
                  className={`color-preset ${color === c ? 'chosen' : ''}`}
                  style={{ '--swatch': c } as React.CSSProperties}
                  aria-label={`${palette.label}のカラープリセット${i + 1}`}
                  aria-pressed={color === c}
                  title={`${palette.label}のカラープリセット${i + 1}（入力設定で変更）`}
                  onClick={() => chooseColor(i)}
                />
              ))}
              <label className="width-select">
                <span
                  className={`width-preview ${widthTool === 'eraser' ? 'eraser-preview' : ''}`}
                  style={{
                    height: widthTool === 'eraser' ? 16 : Math.min(toolWidth, 10),
                    background:
                      widthTool === 'eraser' ? '#fff' : widthTool === 'laser' ? '#ff3c3c' : color,
                  }}
                />
                <select
                  aria-label={widthLabel}
                  value={toolWidth}
                  onChange={(e) =>
                    widthTool === 'laser'
                      ? setPreferences((p) => ({ ...p, laserWidth: Number(e.target.value) }))
                      : widthTool === 'eraser'
                        ? setPreferences((p) => ({ ...p, eraserWidth: Number(e.target.value) }))
                        : setPreferences((p) => ({
                            ...p,
                            [palette.widthPreference]: Number(e.target.value),
                          }))
                  }
                >
                  {widthOptions.map((v) => (
                    <option key={v} value={v}>
                      {v} {widthTool === 'laser' || widthTool === 'eraser' ? 'px' : 'pt'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="toolbar-spacer" />
            <div className="history-tools">
              <IconButton label="元に戻す" onClick={() => undoRedo()} disabled={!h?.undo.length}>
                <Undo2 size={21} />
              </IconButton>
              <IconButton
                label="やり直す"
                onClick={() => undoRedo(true)}
                disabled={!h?.redo.length}
              >
                <Redo2 size={21} />
              </IconButton>
            </div>
            <div className="toolbar-divider" />
            <IconButton
              label="ページ一覧"
              onClick={() =>
                (fullscreen ? setFullscreenSidebar : setSidebar)((visible) => !visible)
              }
              active={showSidebar}
            >
              <LayoutGrid size={21} />
            </IconButton>
            <details className="settings-menu">
              <summary className="icon-button" title="入力設定" aria-label="入力設定">
                <Settings2 size={20} />
              </summary>
              <div className="dropdown settings-dropdown">
                <label>
                  <input
                    type="checkbox"
                    checked={fingerInk}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setPreferences((p) => ({ ...p, fingerInk: enabled }));
                      if (enabled && tool === 'hand') setTool(lastWritingTool.current);
                    }}
                  />{' '}
                  指でも筆記する
                </label>
                <small>
                  通常はOFF。指は移動、Pencilは直前の筆記ツールを使用します。「移動」への切替は不要です。
                </small>
                <label>
                  <input
                    type="checkbox"
                    checked={preferences.palmRejection}
                    onChange={(e) =>
                      setPreferences((p) => ({ ...p, palmRejection: e.target.checked }))
                    }
                  />{' '}
                  手のひらの誤操作を抑える
                </label>
                <small>
                  Pencil使用中の接触と、置いたままの手を無視します。指だけで使うときは接触面の大きさで筆記・ピンチを止めません。
                </small>
                <label>
                  <input
                    type="checkbox"
                    checked={preferences.twoFingerTap}
                    onChange={(e) =>
                      setPreferences((p) => ({ ...p, twoFingerTap: e.target.checked }))
                    }
                  />{' '}
                  2本指タップでペン／消しゴム
                </label>
                <small>
                  Pencil本体のダブルタップはSafariの公開APIでは取得できません。画面への2本指タップを使えます。
                </small>
                <div className="preset-settings">
                  {Object.values(inkPalettes).map(({ label, preference }) => (
                    <div key={preference} className="preset-palette">
                      <span>{label}のカラープリセット</span>
                      <div className="preset-swatches">
                        {preferences[preference].map((c, i) => (
                          <label key={i}>
                            <span>{i + 1}</span>
                            <input
                              type="color"
                              aria-label={`${label}のプリセット${i + 1}の色を変更`}
                              value={c}
                              onChange={(e) => {
                                const next = e.target.value;
                                setPreferences((p) => ({
                                  ...p,
                                  [preference]: p[preference].map((color, j) =>
                                    i === j ? next : color,
                                  ),
                                }));
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={trail}
                    onChange={(e) => setTrail(e.target.checked)}
                  />{' '}
                  レーザーの軌跡を表示
                </label>
              </div>
            </details>
            {Object.entries(videoPlayback).map(([key, actions], i) => (
              <div
                key={key}
                className="toolbar-video-actions"
                role="group"
                aria-label={`動画${i + 1}の操作`}
              >
                <PlaybackButtons actions={actions} />
              </div>
            ))}
            {fullscreen && !documentTools && (
              <span
                className="toolbar-save-indicator"
                role="status"
                aria-label={saved ? '保存済み' : '保存中'}
                title={saved ? '保存済み' : '保存中'}
              >
                {saved ? <Check size={15} /> : <Loader2 size={15} className="spin" />}
              </span>
            )}
            {fullscreen && (
              <button
                type="button"
                className="icon-button"
                title="資料メニュー"
                aria-label="資料メニュー"
                aria-expanded={documentTools}
                aria-controls="document-tools"
                onClick={() => setDocumentTools((open) => !open)}
              >
                <FileText size={19} />
              </button>
            )}
            <IconButton
              label={fullscreen ? '全画面表示を終了' : '全画面表示'}
              onClick={toggleFullscreen}
              active={fullscreen}
            >
              {fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}
            </IconButton>
          </div>
          <div className="editor-body">
            {showSidebar && (
              <aside className="page-sidebar">
                <div className="sidebar-heading">
                  ページ <span>{project.pages.length}</span>
                </div>
                <div className="page-list">
                  {project.pages.map((pg, i) => (
                    <div
                      key={pg.id}
                      className={`page-item ${i === project.currentPage ? 'current' : ''}`}
                    >
                      <button
                        className="page-preview"
                        aria-label={`ページ ${i + 1}`}
                        aria-current={i === project.currentPage ? 'page' : undefined}
                        onClick={() => update((p) => ({ ...p, currentPage: i }))}
                      >
                        <Thumbnail page={pg} shouldPause={inkPriority.isBusy} />
                        <span>
                          {String(i + 1).padStart(2, '0')}
                          {pg.videos.length > 0 && <Video size={12} />}
                        </span>
                      </button>
                      <div className="page-actions">
                        <IconButton
                          label={`ページ${i + 1}を前へ`}
                          onClick={() => movePage(i, -1)}
                          disabled={i === 0}
                        >
                          <ArrowUp size={14} />
                        </IconButton>
                        <IconButton
                          label={`ページ${i + 1}を後へ`}
                          onClick={() => movePage(i, 1)}
                          disabled={i === project.pages.length - 1}
                        >
                          <ArrowDown size={14} />
                        </IconButton>
                        <IconButton
                          label={`ページ${i + 1}を削除`}
                          onClick={() => setDialog({ kind: 'deletePage', id: pg.id })}
                          disabled={project.pages.length <= 1}
                        >
                          <Trash2 size={14} />
                        </IconButton>
                      </div>
                    </div>
                  ))}
                </div>
                <button className="add-page" onClick={addBlank}>
                  <Plus size={17} /> 白紙を追加
                </button>
              </aside>
            )}
            <div className="canvas-area">
              {page && (
                <Stage
                  key={`${project.id}:${preferences.pageMode}`}
                  page={page}
                  continuousPages={
                    preferences.pageMode === 'continuous' ? project.pages : undefined
                  }
                  onFocusPage={focusPage}
                  tool={tool}
                  color={color}
                  width={width}
                  laserWidth={preferences.laserWidth}
                  eraserWidth={preferences.eraserWidth}
                  fingerInk={fingerInk}
                  pencilTool={pencilTool.current}
                  palmRejection={preferences.palmRejection}
                  twoFingerTap={preferences.twoFingerTap}
                  onToggleEraser={toggleEraser}
                  trail={trail}
                  registerPlayback={registerPlayback}
                  fitWidth={fitWidth}
                  zoom={zoom}
                  setZoom={setZoom}
                  inkClipboard={inkClipboard}
                  inkPriority={inkPriority}
                  onCopyInk={setInkClipboard}
                  onChange={changePage}
                  onNavigate={navigate}
                  onError={setError}
                />
              )}
              {fullscreen && (
                <>
                  <button
                    className="edge-nav prev"
                    aria-label="前のページ"
                    disabled={project.currentPage === 0}
                    onClick={() => navigate(-1)}
                  >
                    <ChevronLeft />
                  </button>
                  <button
                    className="edge-nav next"
                    aria-label="次のページ"
                    disabled={project.currentPage === project.pages.length - 1}
                    onClick={() => navigate(1)}
                  >
                    <ChevronRight />
                  </button>
                </>
              )}
            </div>
          </div>
          <footer className="editor-footer">
            <span className="footer-tool">
              <span className="live-dot" /> {tools.find((t) => t.id === tool)?.label}ツール
              {!fullscreen && (
                <span className="footer-hint">
                  {tool === 'hand'
                    ? '動画のサムネイルをタップして配置を編集'
                    : preferences.pageMode === 'continuous'
                      ? 'Pencilで書く、指で上下にスクロール'
                      : 'Pencilで書く、指でめくる'}
                </span>
              )}
            </span>
            <div className="page-navigation">
              <IconButton
                label="前のページ"
                onClick={() => navigate(-1)}
                disabled={project.currentPage === 0}
              >
                <ChevronLeft size={18} />
              </IconButton>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = Number(jump);
                  if (Number.isInteger(n) && n >= 1 && n <= project.pages.length)
                    update((p) => ({ ...p, currentPage: n - 1 }));
                  else setJump(String(project.currentPage + 1));
                }}
              >
                <input
                  aria-label="ページ番号"
                  inputMode="numeric"
                  value={jump}
                  onChange={(e) => setJump(e.target.value)}
                  onBlur={() => setJump(String(project.currentPage + 1))}
                />
                <span>/ {project.pages.length}</span>
              </form>
              <IconButton
                label="次のページ"
                onClick={() => navigate(1)}
                disabled={project.currentPage === project.pages.length - 1}
              >
                <ChevronRight size={18} />
              </IconButton>
            </div>
            <div className="zoom-control">
              <select
                aria-label="ページ表示"
                title="ページ表示"
                value={preferences.pageMode}
                onChange={(e) =>
                  setPreferences((p) => ({
                    ...p,
                    pageMode: e.target.value === 'single' ? 'single' : 'continuous',
                  }))
                }
              >
                <option value="continuous">連続</option>
                <option value="single">1ページずつ</option>
              </select>
              <select
                aria-label="表示方法"
                value={fitWidth ? 'width' : 'page'}
                onChange={(e) => {
                  setFitWidth(e.target.value === 'width');
                  setZoom(1);
                }}
              >
                <option value="page">ページ全体</option>
                <option value="width">幅に合わせる</option>
              </select>
              <button
                onClick={() => {
                  setFitWidth(false);
                  setZoom(1);
                }}
                title="ページ全体を表示"
              >
                フィット
              </button>
              <select
                aria-label="表示倍率"
                value={Number(zoom.toFixed(2))}
                onChange={(e) => setZoom(Number(e.target.value))}
              >
                {!pageZoomSteps.includes(Number(zoom.toFixed(2))) && (
                  <option value={Number(zoom.toFixed(2))}>{Math.round(zoom * 100)}%</option>
                )}
                {pageZoomSteps.map((z) => (
                  <option key={z} value={z}>
                    {z * 100}%
                  </option>
                ))}
              </select>
            </div>
          </footer>
        </>
      )}
      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <IconButton label="エラーを閉じる" onClick={() => setError('')}>
            <X size={18} />
          </IconButton>
        </div>
      )}
      {busy && (
        <div className="busy-overlay" role="status">
          <Loader2 className="spin" size={25} />
          <p>{busy}</p>
        </div>
      )}
      {dialog?.kind === 'video' && (
        <Modal title="YouTube動画を挿入" onClose={() => setDialog(null)}>
          <p className="modal-description">
            教材の中に、もうひとつの伝え方を。
            <br />
            URLを貼り付けると、このページに動画を配置します。
          </p>
          <form onSubmit={insertVideo}>
            <label className="field-label" htmlFor="video-url">
              YouTube URL
            </label>
            <input
              id="video-url"
              className="text-input"
              type="url"
              autoFocus
              required
              placeholder="https://www.youtube.com/watch?v=…"
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
            />
            {videoError && <p className="field-error">{videoError}</p>}
            <p className="form-note">
              サムネイルをタップすると、移動・サイズ変更・折りたたみなどのボタンが出ます。選択後、中央の
              ▶ でページ内再生します。
            </p>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setDialog(null)}>
                キャンセル
              </button>
              <button className="primary" type="submit">
                <Plus size={17} /> このページに追加
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog?.kind === 'rename' && (
        <Modal title="資料名を変更" onClose={() => setDialog(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const d = dialog;
              if (!d.value.trim()) return;
              setDialog(null);
              if (project?.id === d.id) update((p) => ({ ...p, name: d.value.trim() }));
              else
                void run('名前を保存中…', async () => {
                  const p = projects.find((p) => p.id === d.id)!;
                  await saveProject({ ...p, name: d.value.trim(), updatedAt: Date.now() });
                  setProjects(await listProjects());
                });
            }}
          >
            <input
              className="text-input"
              aria-label="資料名"
              autoFocus
              required
              maxLength={200}
              value={dialog.value}
              onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
            />
            <div className="modal-actions">
              <button className="primary">保存する</button>
            </div>
          </form>
        </Modal>
      )}
      {dialog?.kind === 'delete' && (
        <Modal title="講義資料を削除" onClose={() => setDialog(null)}>
          <p>
            「{dialog.name}
            」と書き込みをこのデバイスから削除します。必要な場合は先に資料を開いてバックアップを書き出してください。
          </p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setDialog(null)}>
              キャンセル
            </button>
            <button
              className="danger-button"
              onClick={() => {
                const id = dialog.id;
                setDialog(null);
                void run('削除中…', async () => {
                  await deleteProject(id);
                  setProjects(await listProjects());
                });
              }}
            >
              削除する
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === 'deletePage' && (
        <Modal title="ページを削除" onClose={() => setDialog(null)}>
          <p>このページと、ページ上の手書き・動画配置を削除します。この操作は元に戻せません。</p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setDialog(null)}>
              キャンセル
            </button>
            <button
              className="danger-button"
              onClick={() => {
                const id = dialog.id;
                update((p) => {
                  const pages = p.pages.filter((pg) => pg.id !== id);
                  return { ...p, pages, currentPage: clamp(p.currentPage, 0, pages.length - 1) };
                });
                setDialog(null);
              }}
            >
              ページを削除
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === 'help' && (
        <Modal title="あなたの講義ワークスペース" onClose={() => setDialog(null)}>
          <div className="help-content">
            <h3>書く・動かす</h3>
            <p>
              Pencilまたはマウスで筆記。指1本は移動とページ送り、2本指はピンチで拡大縮小。「入力設定」で指による筆記も有効にできます。「選択」で筆記を囲むかタップすると、枠と操作メニューが出ます。枠内をドラッグすると移動、右下の角をドラッグすると拡大・縮小できます。コピーした筆記は同じタブ内の別ページにも貼り付けられます。消しゴムは上部でサイズを選び、円が通った部分だけを消します。PDF本体は消えません。
            </p>
            <h3>動画で伝える</h3>
            <p>
              YouTubeのURLを挿入し、「移動」ツールで配置します。サムネイルをタップすると同じページで再生。Safariが自動再生を止めた場合は、動画内の再生ボタンをもう一度タップしてください。埋め込み禁止やネットワークエラー時には代替リンクを表示します。
            </p>
            <h3>安心して保存するために</h3>
            <p>
              PDF・筆記・動画配置をこのブラウザのIndexedDBに自動保存します。ブラウザのデータ消去や容量不足で失われる場合があります。大切な教材は「編集可能なバックアップ」を定期的に保存してください。WindowsからiPadへの移行にも、このZIPを使います。別ブラウザ・別URLとは共有されません。
            </p>
            <h3>PDFの書き出し</h3>
            <p>
              PDFと手書きを画像として合成します（最大4096px／ページ、元のテキスト選択や検索は保持しません）。動画は再生リンク付きの枠として出力。動画そのものはPDF内で再生できません。再編集にはバックアップZIPを使ってください。
            </p>
            <h3>講義と画面ミラーリング</h3>
            <p>
              「全画面表示」でPDFを広く表示しながら、同じ編集ツールを使えます。「資料メニュー」から書き出しや更新確認を開けます。動画はサムネイルをタップすると配置メニューが出ます。選択後の再生ボタンでページ内再生します。AirPlay／HDMIで画面をミラーリングするとレーザーも反映されます。
            </p>
            <p className="form-note">
              ショートカット：P ペン / M 蛍光ペン / E 消しゴム / S 選択 / L レーザー / H 移動 / ← →
              ページ移動 / Ctrl・⌘ Z 元に戻す
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
function PlayIcon() {
  return (
    <svg width="25" height="25" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l12-7z" />
    </svg>
  );
}
