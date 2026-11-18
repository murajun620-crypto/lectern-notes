import { useCallback, useEffect, useRef, useState } from 'react';
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
  MoreHorizontal,
  MousePointer2,
  PenLine,
  Plus,
  Presentation,
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
import type { Page, Project, Tool } from './model';
import { blankPage, clamp, drawStrokes, uid, youtubeId } from './model';
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
import { loadInputPreferences } from './input';
import type { PencilTool } from './input';
import { initialVideoRect } from './video-layout';
import UpdateButton from './UpdateButton';
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
function Thumbnail({ page }: { page: Page }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancel = false;
    const canvas = ref.current!;
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      observer.disconnect();
      const temp = document.createElement('canvas');
      void renderPage(page, temp, 160 / page.width)
        .then(() => {
          if (cancel) return;
          canvas.width = temp.width;
          canvas.height = temp.height;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(temp, 0, 0);
          ctx.scale(160 / page.width, 160 / page.width);
          drawStrokes(ctx, page.strokes);
        })
        .catch(() => {});
    });
    observer.observe(canvas);
    return () => {
      cancel = true;
      observer.disconnect();
    };
  }, [page]);
  return <canvas ref={ref} style={{ aspectRatio: `${page.width}/${page.height}` }} />;
}
const tools: { id: Tool; label: string; icon: ReactNode; key: string }[] = [
  { id: 'hand', label: '移動', icon: <Hand />, key: 'H' },
  { id: 'pen', label: 'ペン', icon: <PenLine />, key: 'P' },
  { id: 'highlighter', label: '蛍光ペン', icon: <Highlighter />, key: 'M' },
  { id: 'eraser', label: '消しゴム', icon: <Eraser />, key: 'E' },
  { id: 'select', label: '選択', icon: <MousePointer2 />, key: 'S' },
  { id: 'laser', label: 'レーザー', icon: <Sparkles />, key: 'L' },
];
const colors = ['#183e3a', '#263957', '#cf4d44', '#d59827', '#447cbd', '#8659a5'];
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
  const [tool, setTool] = useState<Tool>('pen'),
    [color, setColor] = useState(colors[0]),
    [width, setWidth] = useState(2.5),
    [preferences, setPreferences] = useState(loadInputPreferences),
    [trail, setTrail] = useState(true),
    [zoom, setZoom] = useState(1),
    [fitWidth, setFitWidth] = useState(false),
    [sidebar, setSidebar] = useState(true),
    [lecture, setLecture] = useState(false);
  const fingerInk = preferences.fingerInk;
  const pencilTool = useRef<PencilTool>('pen'),
    lastWritingTool = useRef<'pen' | 'highlighter'>('pen');
  if (tool !== 'hand') pencilTool.current = tool;
  if (tool === 'pen' || tool === 'highlighter') lastWritingTool.current = tool;
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
  const [revision, setRevision] = useState(0),
    [videoUrl, setVideoUrl] = useState(''),
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
    saveTimer.current = setTimeout(() => void persist(project).catch(() => {}), 300);
    return () => clearTimeout(saveTimer.current);
  }, [project, persist]);
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
    setRevision((r) => r + 1);
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
    setRevision((r) => r + 1);
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select,dialog') || busy || dialog)
        return;
      if (e.key === 'Escape') {
        setLecture(false);
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
  }, [undoRedo, navigate, busy, dialog]);
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
    setLecture(false);
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
      setLecture(false);
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
    const id = youtubeId(videoUrl);
    if (!id) {
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
          videoId: id,
          ...initialVideoRect(page),
        },
      ],
    });
    setDialog(null);
    setTool('hand');
  };
  const h = page ? history.current.get(page.id) : undefined;
  void revision;
  const toggleLecture = () => {
    setLecture((l) => !l);
    setTool('pen');
  };
  const visibleProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div
      className={`app ${project ? 'editor' : 'library'} ${lecture ? 'lecture' : ''}`}
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
          <header className="editor-header">
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
              <button
                className={`primary lecture-button ${lecture ? 'is-lecture' : ''}`}
                onClick={toggleLecture}
              >
                <Presentation size={18} />
                {lecture ? '編集に戻る' : '講義を始める'}
              </button>
            </div>
          </header>
          <div className="toolbar">
            <div className="tool-group">
              {tools
                .filter((t) => !lecture || ['pen', 'eraser', 'laser', 'hand'].includes(t.id))
                .map((t) => (
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
            {!lecture && (
              <>
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
              </>
            )}
            <div className="ink-settings">
              <label className="color-picker" title="ペンの色">
                <input
                  type="color"
                  aria-label="ペンの色"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                />
                <span style={{ background: color }} />
              </label>
              {preferences.presets.map((c, i) => (
                <button
                  key={i}
                  className={`color-preset ${color === c ? 'chosen' : ''}`}
                  style={{ '--swatch': c } as React.CSSProperties}
                  aria-label={`カラープリセット${i + 1}`}
                  aria-pressed={color === c}
                  title={`カラープリセット${i + 1}（入力設定で変更）`}
                  onClick={() => setColor(c)}
                />
              ))}
              <label className="width-select">
                <span
                  className="width-preview"
                  style={{ height: Math.min(width, 10), background: color }}
                />
                <select
                  aria-label="ペンの太さ"
                  value={width}
                  onChange={(e) => setWidth(Number(e.target.value))}
                >
                  {[1, 2.5, 4, 7, 10].map((v) => (
                    <option key={v} value={v}>
                      {v} pt
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
              onClick={() => setSidebar((s) => !s)}
              active={sidebar && !lecture}
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
                    onChange={(e) => setPreferences((p) => ({ ...p, fingerInk: e.target.checked }))}
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
                  Pencil使用中の接触、置いたままの手、大きな接触を無視します。離した後に新しく置いた指はすぐ使えます。
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
                  <span>カラープリセット</span>
                  <div>
                    {preferences.presets.map((c, i) => (
                      <label key={i}>
                        <span>{i + 1}</span>
                        <input
                          type="color"
                          aria-label={`プリセット${i + 1}の色を変更`}
                          value={c}
                          onChange={(e) => {
                            const next = e.target.value;
                            setPreferences((p) => ({
                              ...p,
                              presets: p.presets.map((color, j) => (i === j ? next : color)),
                            }));
                          }}
                        />
                      </label>
                    ))}
                  </div>
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={trail}
                    onChange={(e) => setTrail(e.target.checked)}
                  />{' '}
                  レーザーの軌跡を表示
                </label>
                <button
                  onClick={() => {
                    if (
                      !document.fullscreenEnabled ||
                      !document.documentElement.requestFullscreen
                    ) {
                      toggleLecture();
                      return;
                    }
                    if (!document.fullscreenElement)
                      void document.documentElement
                        .requestFullscreen?.()
                        .catch(() => setLecture(true));
                    else void document.exitFullscreen();
                  }}
                >
                  <Maximize size={16} />{' '}
                  {document.fullscreenEnabled ? '全画面表示を切替' : '画面いっぱいの講義表示'}
                </button>
              </div>
            </details>
          </div>
          <div className="editor-body">
            {sidebar && !lecture && (
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
                        <Thumbnail page={pg} />
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
                  page={page}
                  tool={tool}
                  color={color}
                  width={width}
                  fingerInk={fingerInk}
                  pencilTool={pencilTool.current}
                  palmRejection={preferences.palmRejection}
                  twoFingerTap={preferences.twoFingerTap}
                  onToggleEraser={toggleEraser}
                  trail={trail}
                  lecture={lecture}
                  fitWidth={fitWidth}
                  zoom={zoom}
                  setZoom={setZoom}
                  onChange={changePage}
                  onNavigate={navigate}
                  onError={setError}
                />
              )}
              {lecture && (
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
              {lecture ? (
                <>
                  <span className="live-dot" /> 講義モード
                </>
              ) : (
                <>
                  <span className="live-dot" /> {tools.find((t) => t.id === tool)?.label}ツール
                </>
              )}
              {!lecture && (
                <span className="footer-hint">
                  {tool === 'hand'
                    ? '動画の上部で移動・右下でサイズ変更'
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
                {![1, 1.25, 1.5, 2, 3, 4, 5].includes(Number(zoom.toFixed(2))) && (
                  <option value={Number(zoom.toFixed(2))}>{Math.round(zoom * 100)}%</option>
                )}
                {[1, 1.25, 1.5, 2, 3, 4, 5].map((z) => (
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
              配置後は「移動」ツールで位置とサイズを調整できます。講義モードでは配置を固定し、タップでページ内再生します。
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
              Pencilまたはマウスで筆記。指1本は移動とページ送り、2本指はピンチで拡大縮小。「入力設定」で指による筆記も有効にできます。選択ツールでは線を囲み、選択した線をドラッグで移動できます。消しゴムは線全体を消します。
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
              「講義を始める」でツールバーを縮小し、動画の移動をロックします。AirPlay／HDMIの画面ミラーリングにレーザーも反映されます。外部ディスプレイ専用ウィンドウはありません。初回のiPad実機・投影確認を講義前に行ってください。
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
