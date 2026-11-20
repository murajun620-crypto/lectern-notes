import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  BookOpen,
  BookmarkPlus,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerUpLeft,
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
  Save,
  Search,
  Share,
  Settings2,
  Sparkles,
  Tags,
  Trash2,
  Undo2,
  Upload,
  Video,
  X,
  CircleHelp,
  HardDrive,
  ArrowUpRight,
  CircleAlert,
} from 'lucide-react';
import type { Page, PenKind, Project, Stroke, Tool } from './model';
import {
  blankPage,
  clamp,
  drawStrokes,
  isPenKind,
  parseYoutubeUrl,
  penKinds,
  penOutline,
  uid,
} from './model';
import {
  deleteProject,
  download,
  exportBackup,
  importBackup,
  listProjects,
  saveProject,
  saveProjectWithPdf,
  setProjectTags,
} from './storage';
import { matchesTag, ProjectTagForm, TagFilter } from './ProjectTags';
import { PdfShare } from './PdfShare';
import { demoFile, exportPdf, importPdf, releasePdfs, renderPage } from './pdf';
import Stage, { type StageLocation } from './Stage';
import {
  createInkPriority,
  highlighterWidths,
  toolWidthRanges,
  loadInputPreferences,
  penWidths,
} from './input';
import type { PencilTool } from './input';
import { createInkControlGuard } from './ink-control-guard';
import { createPencilDiagnostics } from './pencil-diagnostics';
import type { PencilDiagnostics } from './pencil-diagnostics';
import { initialVideoRect } from './video-layout';
import { PlaybackButtons } from './VideoBox';
import type { PlaybackActions, RegisterPlayback } from './VideoBox';
import { pageZoomSteps } from './usePageViewport';
import UpdateButton from './UpdateButton';
import { useFullscreen } from './useFullscreen';
import { useProjectFile } from './useProjectFile';
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
const penKindLabels: Record<PenKind, string> = {
  ballpoint: 'ボールペン',
  fountain: '万年筆',
  pencil: '鉛筆',
  brush: '筆ペン',
};
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
class EditorSaveError extends Error {}
type Dialog =
  | { kind: 'rename'; id: string; value: string }
  | { kind: 'tags'; id: string }
  | { kind: 'delete'; id: string; name: string }
  | { kind: 'deletePage'; id: string }
  | { kind: 'sharePdf'; file: File }
  | { kind: 'video' }
  | { kind: 'help' }
  | null;
export default function App() {
  const [projects, setProjects] = useState<Project[]>([]),
    [project, setProject] = useState<Project | null>(null),
    [initialized, setInitialized] = useState(false);
  const [inkClipboard, setInkClipboard] = useState<Stroke[]>([]);
  const [subjectFilter, setSubjectFilter] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const tagChoices = useMemo(
    () => ({
      subjects: [...new Set(projects.flatMap((p) => (p.subject ? [p.subject] : [])))].sort((a, b) =>
        a.localeCompare(b, 'ja'),
      ),
      years: [...new Set(projects.flatMap((p) => (p.academicYear ? [p.academicYear] : [])))]
        .sort()
        .reverse(),
    }),
    [projects],
  );
  const [inkPriority] = useState(createInkPriority);
  const [pencilDiagnostics, setPencilDiagnostics] = useState<PencilDiagnostics | null>(null);
  const [inkControlGuard] = useState(() => createInkControlGuard(inkPriority));
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
  const captureViewRef = useRef<(() => StageLocation) | null>(null);
  const [returnViews, setReturnViews] = useState<StageLocation[]>([]);
  const [restoreLocation, setRestoreLocation] = useState<StageLocation | null>(null);
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
  const widthPreference =
    widthTool === 'laser'
      ? 'laserWidth'
      : widthTool === 'eraser'
        ? 'eraserWidth'
        : palette.widthPreference;
  const toolWidth = preferences[widthPreference];
  const erasing = widthTool === 'eraser';
  const widthRange =
    widthPreference === 'laserWidth' ? undefined : toolWidthRanges[widthPreference];
  const widthUnit = widthRange?.unit ?? 'px';
  const inkScale = useRef(1);
  const toolbarNib = useRef<HTMLSpanElement>(null);
  const paperNib = useRef<HTMLSpanElement>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Use the paper's live transform without rerendering the editor on every pinch frame.
  const syncNibScale = useCallback((scale: number) => {
    if (scale === inkScale.current) return;
    inkScale.current = scale;
    toolbarNib.current?.style.setProperty('--ink-scale', String(scale));
    paperNib.current?.style.setProperty('--ink-scale', String(scale));
  }, []);
  const showNib = () => {
    const layer = paperNib.current?.parentElement;
    if (!layer) return;
    clearTimeout(previewTimer.current);
    layer.dataset.visible = '';
    previewTimer.current = setTimeout(() => delete layer.dataset.visible, 1200);
  };
  useEffect(() => () => clearTimeout(previewTimer.current), []);
  const setToolWidth = (value: number) => {
    showNib();
    setPreferences((p) => ({ ...p, [widthPreference]: value }));
  };
  // Measure the nib that produces a dot at the pressure used by finger and mouse input.
  const nibSize = useMemo(() => {
    if (writingTool === 'highlighter') return width;
    const outline = penOutline({
      id: 'sample',
      tool: 'pen',
      penKind: preferences.penStyle,
      width,
      color: '#000000',
      points: [{ x: 0, y: 0, p: 0.5 }],
    });
    return 2 * Math.max(...outline.map(([, y]) => y));
  }, [writingTool, width, preferences.penStyle]);
  const nibStyle = {
    width: erasing ? toolWidth : nibSize,
    height: erasing ? toolWidth : nibSize,
    backgroundColor: erasing ? undefined : color,
    opacity: !erasing && writingTool === 'highlighter' ? 0.3 : undefined,
    '--ink-scale': inkScale.current,
  } as React.CSSProperties;
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
    [saveIssue, setSaveIssue] = useState(''),
    [showSaveIssue, setShowSaveIssue] = useState(false),
    [query, setQuery] = useState(''),
    [jump, setJump] = useState('1');
  const [videoUrl, setVideoUrl] = useState(''),
    [videoError, setVideoError] = useState('');
  const input = useRef<HTMLInputElement>(null),
    backupInput = useRef<HTMLInputElement>(null),
    append = useRef(false),
    current = useRef(project),
    savedSnapshot = useRef<Project | null>(null);
  useLayoutEffect(() => {
    current.current = project;
  }, [project]);
  const history = useRef(new Map<string, { undo: Page[]; redo: Page[] }>());
  const queue = useRef(Promise.resolve()),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const persist = useCallback(
    (p: Project, automatic = false) => {
      const write = queue.current.then(async () => {
        if (savedSnapshot.current === p) return true;
        // An earlier write can keep an autosave queued until the Pencil is down again.
        if (automatic && (current.current !== p || inkPriority.isBusy())) return false;
        await saveProject(p);
        savedSnapshot.current = p;
        return true;
      });
      queue.current = write.then(
        () => undefined,
        () => undefined,
      );
      return write
        .then((written) => {
          if (written && current.current === p) {
            setSaved(true);
            setSaveIssue('');
          }
          return written;
        })
        .catch((e) => {
          const message = (e as Error).message;
          if (current.current?.id === p.id) {
            setSaved(false);
            setSaveIssue(message);
            setShowSaveIssue(true);
          }
          throw new EditorSaveError(message, { cause: e });
        });
    },
    [inkPriority],
  );
  const flush = useCallback(async () => {
    while (current.current && current.current !== savedSnapshot.current) {
      await persist(current.current);
    }
  }, [persist]);
  useEffect(() => {
    void listProjects()
      .then((items) => {
        setProjects(items);
        try {
          const last = items.find((p) => p.id === localStorage.getItem('lectern.active'));
          if (last) {
            savedSnapshot.current = last;
            setProject(last);
          }
        } catch {
          /* IndexedDB is still usable when localStorage is blocked. */
        }
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setInitialized(true));
  }, []);
  useEffect(() => {
    if (!project) return;
    if (project === savedSnapshot.current) {
      setSaved(true);
      setSaveIssue('');
      return;
    }
    setSaved(false);
    let stopped = false;
    const autosave = () => {
      if (stopped || current.current !== project) return;
      const retry = () => {
        if (!stopped && current.current === project) saveTimer.current = setTimeout(autosave, 100);
      };
      if (inkPriority.isBusy()) retry();
      else
        void persist(project, true)
          .then((written) => {
            if (!written) retry();
          })
          .catch(() => {});
    };
    saveTimer.current = setTimeout(autosave, 300);
    return () => {
      stopped = true;
      clearTimeout(saveTimer.current);
    };
  }, [project, persist, inkPriority]);
  useEffect(() => {
    const saveOnTransition = () => {
      void flush().catch(() => {});
    };
    document.addEventListener('visibilitychange', saveOnTransition);
    window.addEventListener('pagehide', saveOnTransition);
    window.addEventListener('pageshow', saveOnTransition);
    return () => {
      document.removeEventListener('visibilitychange', saveOnTransition);
      window.removeEventListener('pagehide', saveOnTransition);
      window.removeEventListener('pageshow', saveOnTransition);
    };
  }, [flush]);
  useEffect(() => {
    if (saved) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (!current.current || current.current === savedSnapshot.current) return;
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saved]);
  const update = (fn: (p: Project) => Project) => {
    setSaved(false);
    setProject((p) => (p ? { ...fn(p), updatedAt: Date.now() } : p));
  };
  const page = project?.pages[project.currentPage];
  const returnView = returnViews.at(-1);
  const returnPage =
    returnView && project ? project.pages.findIndex((pg) => pg.id === returnView.pageId) : -1;
  const rememberView = () => {
    const location = captureViewRef.current?.();
    if (!location) return;
    setReturnViews((entries) => {
      const last = entries.at(-1);
      if (
        last &&
        last.pageId === location.pageId &&
        last.fitWidth === location.fitWidth &&
        Math.abs(last.zoom - location.zoom) < 0.0001 &&
        Math.hypot(last.center.x - location.center.x, last.center.y - location.center.y) < 0.1
      )
        return entries;
      return [...entries.slice(-15), location];
    });
  };
  const jumpToPage = (index: number) => {
    if (!project || index === project.currentPage) return;
    rememberView();
    setRestoreLocation(null);
    update((p) => ({ ...p, currentPage: index }));
  };
  const returnToView = () => {
    if (!returnView || returnPage < 0 || !project) return;
    setReturnViews((entries) => entries.slice(0, -1));
    setFitWidth(returnView.fitWidth);
    setZoom(returnView.zoom);
    setRestoreLocation(returnView);
    if (returnPage !== project.currentPage) update((p) => ({ ...p, currentPage: returnPage }));
  };
  const replacePage = useCallback((p: Project, next: Page) => {
    const updatedAt = Date.now();
    const replace = (base: Project) => ({
      ...base,
      updatedAt,
      pages: base.pages.map((pg) => (pg.id === next.id ? next : pg)),
    });
    // A second short stroke can finish before React renders the first edit.
    const updated = replace(p);
    current.current = updated;
    setProject((base) => (base === p ? updated : base?.id === p.id ? replace(base) : base));
  }, []);
  const changePage = useCallback(
    (id: string, edit: (prev: Page) => Page) => {
      const p = current.current;
      if (!p) return;
      const prev = p.pages.find((pg) => pg.id === id);
      if (!prev) return;
      const next = edit(prev);
      if (next === prev) return;
      setSaved(false);
      const h = history.current.get(id) || { undo: [], redo: [] };
      h.undo.push(prev);
      if (h.undo.length > 60) h.undo.shift();
      h.redo = [];
      history.current.set(id, h);
      replacePage(p, next);
    },
    [replacePage],
  );
  const navigate = useCallback((delta: number) => {
    setRestoreLocation(null);
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
  const undoRedo = useCallback(
    (redo = false) => {
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
      replacePage(p, next);
    },
    [replacePage],
  );
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
      if (e instanceof EditorSaveError) return;
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
      await flush();
    }
    try {
      localStorage.setItem('lectern.active', p.id);
    } catch {
      /* Optional last-opened preference. */
    }
    savedSnapshot.current = p;
    setSaved(true);
    setSaveIssue('');
    setProject(p);
    setReturnViews([]);
    setRestoreLocation(null);
    history.current.clear();
    setZoom(1);
    exitFullscreen();
    setTool('pen');
    void navigator.storage?.persist?.().catch(() => {});
  };
  const projectFile = useProjectFile(project?.id, open, run);
  const newFromPdf = async (file: File, adding = false) => {
    const { pages, asset } = await importPdf(file);
    if (adding && current.current) {
      await flush();
      const base = current.current;
      if (!base) return;
      const appendPages = (p: Project) => ({
        ...p,
        pages: [...p.pages, ...pages],
        currentPage: p.pages.length,
        updatedAt: Date.now(),
      });
      const next = appendPages(base);
      await saveProjectWithPdf(next, asset);
      savedSnapshot.current = next;
      setProject((p) => (p === base ? next : p?.id === base.id ? appendPages(p) : p));
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
    await saveProjectWithPdf(p, asset);
    await open(p);
  };
  const returnLibrary = () =>
    void run('保存中…', async () => {
      if (current.current) {
        clearTimeout(saveTimer.current);
        await flush();
      }
      try {
        localStorage.removeItem('lectern.active');
      } catch {
        /* Optional last-opened preference. */
      }
      setProject(null);
      setReturnViews([]);
      setRestoreLocation(null);
      exitFullscreen();
      releasePdfs();
      setProjects(await listProjects());
    });
  const backup = () => {
    const snapshot = current.current;
    if (snapshot)
      void run('バックアップを作成中…', async () => {
        download(await exportBackup(snapshot), `${snapshot.name}.lecture.zip`);
      });
  };
  const beforeReload = async () => {
    if (current.current) {
      clearTimeout(saveTimer.current);
      await flush();
    }
  };
  const exportDocument = (share = false) => {
    const snapshot = current.current;
    if (!snapshot) return;
    void run('PDFを書き出し中…', async () => {
      const blob = await exportPdf(snapshot, setBusy);
      const name = `${snapshot.name}-書き込み.pdf`;
      if (share) {
        setDialog({ kind: 'sharePdf', file: new File([blob], name, { type: 'application/pdf' }) });
      } else {
        download(blob, name);
      }
    });
  };
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
    changePage(page.id, (prev) => ({
      ...prev,
      videos: [
        ...prev.videos,
        {
          id: uid(),
          videoId: source.id,
          ...initialVideoRect(prev, source.portrait),
        },
      ],
    }));
    setDialog(null);
    setTool('hand');
  };
  const h = page ? history.current.get(page.id) : undefined;
  const visibleProjects = useMemo(() => {
    const term = query.trim().normalize('NFKC').toLowerCase();
    return projects.filter(
      (p) =>
        matchesTag(p.subject, subjectFilter) &&
        matchesTag(p.academicYear, yearFilter) &&
        [p.name, p.subject, p.academicYear && `${p.academicYear}年度`].some((v) =>
          v?.normalize('NFKC').toLowerCase().includes(term),
        ),
    );
  }, [projects, query, subjectFilter, yearFilter]);
  const filtering = Boolean(query || subjectFilter || yearFilter);
  const tagging =
    dialog?.kind === 'tags'
      ? project?.id === dialog.id
        ? project
        : projects.find((p) => p.id === dialog.id)
      : undefined;
  const pageAndViewControls = project && (
    <>
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
            if (Number.isInteger(n) && n >= 1 && n <= project.pages.length) jumpToPage(n - 1);
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
        <IconButton label="ここを覚える" onClick={rememberView}>
          <BookmarkPlus size={18} />
        </IconButton>
      </div>
      <div className="zoom-control">
        <select
          aria-label="ページ表示"
          title="ページ表示"
          value={preferences.pageMode}
          onChange={(e) => {
            setRestoreLocation(null);
            setPreferences((p) => ({
              ...p,
              pageMode: e.target.value === 'single' ? 'single' : 'continuous',
            }));
          }}
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
    </>
  );
  const failedSaveButton = (
    <button
      type="button"
      className="save-failed"
      onClick={() => setShowSaveIssue(true)}
      title="保存エラーの詳細"
    >
      <CircleAlert size={15} />
      未保存
    </button>
  );
  const visibleSaveIssue = !error && showSaveIssue && saveIssue;
  return (
    <div
      className={`app ${project ? 'editor' : 'library'} ${fullscreen ? 'is-fullscreen' : ''}`}
      {...inkControlGuard}
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
      <input
        hidden
        type="file"
        ref={projectFile.inputRef}
        aria-label="Lecternプロジェクトファイル"
        onChange={projectFile.readInput}
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
                <span>
                  {filtering ? `${visibleProjects.length} / ${projects.length}` : projects.length}{' '}
                  件の資料
                </span>
              </div>
              <div className="action-group">
                <button className="text-button" onClick={() => backupInput.current?.click()}>
                  <Upload size={17} /> バックアップを復元
                </button>
                <button className="secondary" onClick={projectFile.chooseFile}>
                  <FolderOpen size={17} /> プロジェクトを開く
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
              <div className="library-filters">
                <label className="search">
                  <Search size={18} />
                  <input
                    placeholder="資料を検索"
                    aria-label="資料を検索"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <TagFilter
                  label="科目"
                  options={tagChoices.subjects}
                  value={subjectFilter}
                  onChange={setSubjectFilter}
                />
                <TagFilter
                  label="年度"
                  options={tagChoices.years}
                  value={yearFilter}
                  onChange={setYearFilter}
                />
                {filtering && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setQuery('');
                      setSubjectFilter('');
                      setYearFilter('');
                    }}
                  >
                    絞り込みを解除
                  </button>
                )}
              </div>
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
                      {(p.subject || p.academicYear) && (
                        <div className="project-tags">
                          {p.subject && <span>{p.subject}</span>}
                          {p.academicYear && <span>{p.academicYear}年度</span>}
                        </div>
                      )}
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
                        <button onClick={() => setDialog({ kind: 'tags', id: p.id })}>
                          <Tags size={16} /> 科目・年度を編集
                        </button>
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
            <header className="editor-header" id="document-tools" data-ink-controls="">
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
              {saveIssue ? (
                failedSaveButton
              ) : (
                <span
                  className={`save-status ${saved ? '' : 'saving'}`}
                  title="この端末のライブラリへの自動保存"
                >
                  {saved ? <Check size={14} /> : <Loader2 size={14} className="spin" />}
                  {saved ? '保存済み' : '保存中'}
                </span>
              )}
              <div className="header-end">
                <UpdateButton beforeReload={beforeReload} />
                <button
                  className="secondary"
                  title="プロジェクトを保存"
                  aria-label="プロジェクトを保存"
                  onClick={() => {
                    if (current.current) projectFile.saveFile(current.current);
                  }}
                >
                  <Save size={17} />
                  <span>プロジェクトを保存</span>
                </button>
                <details className="export-menu">
                  <summary className="secondary">
                    <Download size={17} />
                    <span>書き出す</span>
                  </summary>
                  <div className="dropdown">
                    <button onClick={backup}>
                      <Download size={17} /> 編集可能なバックアップ
                    </button>
                    <button onClick={() => exportDocument()}>
                      <FileText size={17} /> 書き込み入りPDF
                    </button>
                    {typeof navigator.share === 'function' && (
                      <button onClick={() => exportDocument(true)}>
                        <Share size={17} /> PDFファイルを共有
                      </button>
                    )}
                    <button onClick={() => setDialog({ kind: 'tags', id: project.id })}>
                      <Tags size={17} /> 科目・年度を編集
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
          <div className="toolbar" data-ink-controls="">
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
              {widthTool === 'pen' && (
                <select
                  className="pen-kind-select"
                  aria-label="ペンの種類"
                  title="ペンの種類"
                  value={preferences.penStyle ?? 'standard'}
                  onChange={(e) => {
                    const choice = e.currentTarget.value;
                    const penStyle = isPenKind(choice) ? choice : undefined;
                    setPreferences((p) => ({ ...p, penStyle }));
                  }}
                >
                  <option value="standard">標準ペン</option>
                  {penKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {penKindLabels[kind]}
                    </option>
                  ))}
                </select>
              )}
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
              <div
                className={widthRange ? 'ink-width-control' : 'width-select'}
                data-ink-tool={erasing ? 'eraser' : writingTool}
              >
                {widthRange ? (
                  <button
                    type="button"
                    className="nib-preview"
                    aria-label="用紙上に太さの見本を表示"
                    title={
                      erasing
                        ? '消しゴムの直径を用紙上に実寸表示'
                        : '用紙上に実寸表示（ペンは標準筆圧の見本）'
                    }
                    onClick={showNib}
                  >
                    <span
                      aria-hidden="true"
                      className={erasing ? 'nib-dot eraser-nib' : 'nib-dot'}
                      ref={toolbarNib}
                      style={nibStyle}
                    />
                  </button>
                ) : (
                  <span
                    className="width-preview"
                    style={{
                      height: Math.min(toolWidth, 10),
                      background: '#ff3c3c',
                    }}
                  />
                )}
                <select
                  aria-label={widthLabel}
                  value={toolWidth}
                  onChange={(e) => setToolWidth(Number(e.currentTarget.value))}
                >
                  {widthRange && !widthOptions.includes(toolWidth) && (
                    <option value={toolWidth}>
                      {toolWidth} {widthUnit}
                    </option>
                  )}
                  {widthOptions.map((v) => (
                    <option key={v} value={v}>
                      {v} {widthUnit}
                    </option>
                  ))}
                </select>
                {widthRange && (
                  <input
                    type="range"
                    aria-label={`${widthLabel}を調整`}
                    aria-valuetext={`${toolWidth} ${widthUnit}`}
                    min={widthRange.min}
                    max={widthRange.max}
                    step={widthRange.step}
                    value={toolWidth}
                    onPointerDown={showNib}
                    onChange={(e) => setToolWidth(e.currentTarget.valueAsNumber)}
                  />
                )}
              </div>
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
            {!preferences.showFooter && (
              <details className="page-view-menu">
                <summary className="icon-button page-view-toggle">ページ・表示</summary>
                <div className="page-view-dropdown">{pageAndViewControls}</div>
              </details>
            )}
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
                    checked={preferences.pencilPressure}
                    onChange={(e) =>
                      setPreferences((p) => ({ ...p, pencilPressure: e.target.checked }))
                    }
                  />{' '}
                  Pencilの筆圧で線の太さを変える
                </label>
                <small>OFFにすると、指で書くときと同じ一定の太さになります。</small>
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
                <label>
                  <input
                    type="checkbox"
                    checked={preferences.showFooter}
                    onChange={(e) =>
                      setPreferences((p) => ({ ...p, showFooter: e.target.checked }))
                    }
                  />{' '}
                  下部バーを表示
                </label>
                <small>
                  オフにすると、ページ送りと表示倍率は上部の「ページ・表示」から操作できます。
                </small>
                <button
                  type="button"
                  className="text-button"
                  onClick={(e) => {
                    if (pencilDiagnostics) {
                      download(
                        new Blob([pencilDiagnostics.report()], { type: 'application/json' }),
                        'lectern-pencil-diagnostics.json',
                      );
                      setPencilDiagnostics(null);
                    } else {
                      setTool('pen');
                      setPencilDiagnostics(createPencilDiagnostics());
                      const menu = e.currentTarget.closest('details');
                      if (menu) menu.open = false;
                    }
                  }}
                >
                  {pencilDiagnostics ? '記録を終了して書き出す' : 'Pencil入力を記録'}
                </button>
                <small>
                  {pencilDiagnostics
                    ? '記録中です。症状が出たら、このメニューから書き出せます。'
                    : 'Pencilの相対位置と、接触の種類・時刻を端末内で記録します。'}
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
            {fullscreen &&
              !documentTools &&
              (saveIssue ? (
                failedSaveButton
              ) : (
                <span
                  className="toolbar-save-indicator"
                  role="status"
                  aria-label={saved ? '保存済み' : '保存中'}
                  title={saved ? '保存済み' : '保存中'}
                >
                  {saved ? <Check size={15} /> : <Loader2 size={15} className="spin" />}
                </span>
              ))}
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
              <aside className="page-sidebar" data-ink-controls="">
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
                        onClick={() => jumpToPage(i)}
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
            <div
              className="canvas-area"
              onPointerDownCapture={() => {
                const layer = paperNib.current?.parentElement;
                if (layer?.hasAttribute('data-visible')) delete layer.dataset.visible;
              }}
            >
              {page && (
                <Stage
                  key={`${project.id}:${preferences.pageMode}`}
                  captureViewRef={captureViewRef}
                  restoreLocation={restoreLocation}
                  page={page}
                  continuousPages={
                    preferences.pageMode === 'continuous' ? project.pages : undefined
                  }
                  onFocusPage={focusPage}
                  tool={tool}
                  penKind={preferences.penStyle}
                  color={color}
                  width={width}
                  laserWidth={preferences.laserWidth}
                  eraserWidth={preferences.eraserWidth}
                  fingerInk={fingerInk}
                  pencilPressure={preferences.pencilPressure}
                  pencilTool={pencilTool.current}
                  palmRejection={preferences.palmRejection}
                  twoFingerTap={preferences.twoFingerTap}
                  onToggleEraser={toggleEraser}
                  trail={trail}
                  registerPlayback={registerPlayback}
                  fitWidth={fitWidth}
                  onInkScaleChange={syncNibScale}
                  zoom={zoom}
                  setZoom={setZoom}
                  inkClipboard={inkClipboard}
                  inkPriority={inkPriority}
                  pencilDiagnostics={pencilDiagnostics}
                  onCopyInk={setInkClipboard}
                  onChange={changePage}
                  onNavigate={navigate}
                  onError={setError}
                />
              )}
              {returnPage >= 0 && (
                <button
                  type="button"
                  className="return-view"
                  data-ink-controls=""
                  aria-label="直前の表示に戻る"
                  title={`${returnPage + 1}ページの元の表示に戻る`}
                  onClick={returnToView}
                >
                  <CornerUpLeft size={16} aria-hidden="true" />
                  {returnPage + 1}ページに戻る
                </button>
              )}
              {widthRange && (
                <div className="paper-nib-preview" aria-hidden="true">
                  <span
                    className={erasing ? 'page-nib-dot eraser-nib' : 'page-nib-dot'}
                    ref={paperNib}
                    style={nibStyle}
                  />
                </div>
              )}
              {fullscreen && (
                <>
                  <button
                    className="edge-nav prev"
                    data-ink-controls=""
                    aria-label="前のページ"
                    disabled={project.currentPage === 0}
                    onClick={() => navigate(-1)}
                  >
                    <ChevronLeft />
                  </button>
                  <button
                    className="edge-nav next"
                    data-ink-controls=""
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
          {preferences.showFooter && (
            <footer className="editor-footer" data-ink-controls="">
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
              {pageAndViewControls}
            </footer>
          )}
        </>
      )}
      <div role="status" aria-live="polite" className="project-file-notice">
        {projectFile.fileNotice}
      </div>
      {projectFile.conflict && (
        <Modal title="この端末に同じ資料があります" onClose={projectFile.cancelConflict}>
          <p>
            「{projectFile.conflict.local.name}
            」には、開こうとしているファイルと異なる内容があります。ファイルの内容で開くと、この端末の資料を置き換えます。
          </p>
          <dl className="project-versions">
            <dt>この端末の更新日時</dt>
            <dd>{new Date(projectFile.conflict.local.updatedAt).toLocaleString('ja-JP')}</dd>
            <dt>ファイルの更新日時</dt>
            <dd>{new Date(projectFile.conflict.incoming.updatedAt).toLocaleString('ja-JP')}</dd>
          </dl>
          <div className="modal-actions">
            <button className="secondary" autoFocus onClick={projectFile.cancelConflict}>
              キャンセル
            </button>
            <button className="primary" onClick={projectFile.replaceConflict}>
              ファイルの内容で開く
            </button>
          </div>
        </Modal>
      )}
      {(error || visibleSaveIssue) && (
        <div className={`error-toast${visibleSaveIssue ? ' save-error' : ''}`} role="alert">
          <span>{error || saveIssue}</span>
          {visibleSaveIssue && (
            <div className="save-error-actions">
              <button onClick={() => void run('保存中…', flush)}>保存を再試行</button>
              <button onClick={backup}>バックアップを書き出す</button>
            </div>
          )}
          <IconButton
            label="エラーを閉じる"
            onClick={() => (error ? setError('') : setShowSaveIssue(false))}
          >
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
      {dialog?.kind === 'sharePdf' && (
        <Modal title="PDFファイルを共有" onClose={() => setDialog(null)}>
          <PdfShare file={dialog.file} onClose={() => setDialog(null)} />
        </Modal>
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
              中央の ▶
              でページ内再生します。サムネイルのほかの部分をタップすると、移動・サイズ変更・折りたたみなどのボタンが出ます。
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
      {tagging && (
        <Modal title="科目・年度を編集" onClose={() => setDialog(null)}>
          <ProjectTagForm
            project={tagging}
            {...tagChoices}
            onCancel={() => setDialog(null)}
            onSave={async (tags) => {
              const active = current.current;
              if (active?.id === tagging.id) {
                const next = { ...active, ...tags, updatedAt: Date.now() };
                // Keep this edit available to retry or back up if the device rejects the write.
                current.current = next;
                setProject(next);
                await persist(next);
              } else {
                await setProjectTags(tagging.id, tags);
                setProjects(await listProjects());
              }
              setDialog((open) => (open === dialog ? null : open));
            }}
          />
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
                setReturnViews((entries) => entries.filter((entry) => entry.pageId !== id));
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
            <h3>説明していた場所に戻る</h3>
            <p>
              ページ一覧やページ番号で別のページへ飛ぶと、用紙の左下に「○ページに戻る」が出ます。タップすると、元の倍率で同じ箇所に戻れます。スクロールで移動するときは、先にページ番号の横の「ここを覚える」を押してください。
            </p>
            <h3>動画で伝える</h3>
            <p>
              中央の ▶
              をタップすると、YouTube動画を同じページで再生します。サムネイルのほかの部分をタップすると配置メニューが開きます。再生中は「閉じる」でサムネイルに戻り、動画の外のページを指でタップすると配置メニューも開きます。Safariが再生を止めた場合は、動画内の再生ボタンをタップしてください。埋め込み禁止やネットワークエラー時には代替リンクを表示します。
            </p>
            <h3>安心して保存するために</h3>
            <p>
              作業中の資料はこの端末のライブラリに自動保存します。WindowsからiPadへ引き継ぐときは「プロジェクトを保存」で
              .lectern
              ファイルをOneDriveなどの共有フォルダに置き、iPadのライブラリで「プロジェクトを開く」を押します。授業後はiPadでもう一度ファイルに保存します。以前のZIPは「バックアップを復元」から開けます。
            </p>
            <h3>PDFの書き出し</h3>
            <p>
              元のPDFの文字・図を保って筆記を重ね、動画は再生リンク付きの枠として書き出します。対応端末では「書き出す
              →
              PDFファイルを共有」からPDFそのものを渡せます。保存したPDFは「ファイル」アプリからも共有できます。別の端末でも編集を続けるには「プロジェクトを保存」を使ってください。
            </p>
            <h3>講義と画面ミラーリング</h3>
            <p>
              「全画面表示」でPDFを広く表示しながら、同じ編集ツールを使えます。「資料メニュー」から書き出しや更新確認を開けます。動画は中央の
              ▶
              で再生し、サムネイルのほかの部分をタップすると配置メニューが出ます。AirPlay／HDMIで画面をミラーリングするとレーザーも反映されます。
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
