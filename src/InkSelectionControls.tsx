import { ClipboardPaste, Copy, Layers2, Minus, Plus, Scissors, Trash2 } from 'lucide-react';
import { clamp } from './model';
import type { Position } from './ink-selection';

export default function InkSelectionControls({
  frame,
  anchor,
  viewport,
  dragging,
  onResize,
  onCopy,
  onDuplicate,
  onRemove,
  onPaste,
}: {
  frame: { left: number; top: number; width: number; height: number } | null;
  anchor: Position | null;
  viewport: { w: number; h: number };
  dragging: boolean;
  onResize: (factor: number) => void;
  onCopy: (cut: boolean) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onPaste?: () => void;
}) {
  const actions = frame
    ? [
        { label: '拡大', icon: Plus, run: () => onResize(1.25) },
        { label: '縮小', icon: Minus, run: () => onResize(0.8) },
        { label: 'コピー', icon: Copy, run: () => onCopy(false) },
        { label: '切り取り', icon: Scissors, run: () => onCopy(true) },
        { label: '複製', icon: Layers2, run: onDuplicate },
        { label: '削除', name: '選択した線を削除', icon: Trash2, run: onRemove },
      ]
    : [];
  if (onPaste) actions.push({ label: '貼り付け', icon: ClipboardPaste, run: onPaste });
  if (!actions.length) return null;
  const width = Math.min(actions.length * 54 + 8, viewport.w - 16);
  const targetX = frame ? frame.left + frame.width / 2 : (anchor?.x ?? viewport.w / 2);
  const x = clamp(targetX - width / 2, 8, viewport.w - width - 8);
  const y = frame
    ? frame.top >= 68
      ? frame.top - 60
      : frame.top + frame.height + 10
    : (anchor?.y ?? viewport.h - 28) - 58;

  return (
    <div className="ink-selection-ui">
      {frame && (
        <div className="ink-selection-frame" style={frame} data-testid="ink-selection-frame">
          <span
            className="ink-selection-handle"
            data-selection-control
            data-ink-resize
            data-testid="ink-resize-handle"
            title="ドラッグで拡大・縮小"
            aria-hidden="true"
          />
        </div>
      )}
      {!dragging && (
        <div
          className="ink-selection-menu"
          data-selection-control
          role="group"
          aria-label="選択した筆記の操作"
          style={{ width, left: x, top: clamp(y, 8, Math.max(8, viewport.h - 60)) }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {actions.map(({ label, name, icon: Icon, run }) => (
            <button key={label} type="button" aria-label={name ?? label} onClick={run}>
              <Icon size={16} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
