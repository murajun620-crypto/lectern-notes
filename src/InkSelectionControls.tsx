import { ClipboardPaste, Copy, Layers2, Minus, Plus, Scissors, Trash2 } from 'lucide-react';
import { useRef } from 'react';
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
  const touch = useRef<{ id: number; x: number; y: number; released: boolean } | null>(null);
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
  const columns = Math.max(1, Math.min(actions.length, Math.floor((viewport.w - 24) / 43)));
  const width = Math.min(columns * 54 + 8, viewport.w - 16);
  const height = Math.ceil(actions.length / columns) * 43 + 8;
  const targetX = frame ? frame.left + frame.width / 2 : (anchor?.x ?? viewport.w / 2);
  const x = clamp(targetX - width / 2, 8, viewport.w - width - 8);
  const y = frame
    ? frame.top >= height + 17
      ? frame.top - height - 9
      : frame.top + frame.height + 10
    : (anchor?.y ?? viewport.h - 28) - height - 7;

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
          style={{
            width,
            left: x,
            top: clamp(y, 8, Math.max(8, viewport.h - height - 9)),
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {actions.map(({ label, name, icon: Icon, run }) => (
            <button
              key={label}
              type="button"
              aria-label={name ?? label}
              onPointerDown={(e) => {
                touch.current =
                  e.pointerType === 'touch' && e.isPrimary
                    ? { id: e.pointerId, x: e.clientX, y: e.clientY, released: false }
                    : null;
              }}
              onPointerCancel={() => {
                touch.current = null;
              }}
              onPointerUp={(e) => {
                const press = touch.current;
                if (!press || press.id !== e.pointerId) return;
                press.released = true;
                // Some browsers suppress a click immediately after dragging a captured pointer.
                if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 10) run();
              }}
              onClick={(e) => {
                if (
                  (e.detail || (e.nativeEvent as PointerEvent).pointerType === 'touch') &&
                  touch.current?.released
                ) {
                  touch.current = null;
                  return;
                }
                run();
              }}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
