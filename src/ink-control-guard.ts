import type { MouseEvent, PointerEvent } from 'react';
import type { InkPriority } from './input';

type Contact = {
  control: Element;
  x: number;
  y: number;
  blocked: boolean;
  startedAt: number;
  releasedAt?: number;
};

const tapDevice = (type: string) => type === 'touch' || type === 'pen';
const controlAt = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return;
  const bar = target.closest('[data-ink-controls]');
  if (bar) return target.closest('button,input,select,summary,a[href],label') ?? bar;
};
const block = (e: MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

/** Preserve the decision from pointerdown through a delayed compatibility click. */
export function createInkControlGuard(ink: InkPriority) {
  const contacts = new Map<number, Contact>();

  const recentContact = (control: Element) => {
    const now = performance.now();
    let recent: [number, Contact] | undefined;
    for (const entry of contacts) {
      const contact = entry[1];
      if (
        contact.control === control &&
        contact.releasedAt !== undefined &&
        now - contact.releasedAt <= 750
      )
        recent = entry;
    }
    return recent;
  };

  const finish = (e: PointerEvent, cancelled = false) => {
    const contact = contacts.get(e.pointerId);
    if (!contact) return;
    contact.releasedAt = performance.now();
    contact.blocked ||=
      cancelled ||
      ink.blocksControls(e.pointerType) ||
      Math.hypot(e.clientX - contact.x, e.clientY - contact.y) > 12;
    if (contact.blocked) block(e);
  };

  return {
    onPointerDownCapture(e: PointerEvent) {
      const control = controlAt(e.target);
      if (!control) return;
      const now = performance.now();
      for (const [id, contact] of contacts) {
        if (
          (contact.releasedAt === undefined
            ? now - contact.startedAt > 10_000
            : now - contact.releasedAt > 750) ||
          (!tapDevice(e.pointerType) && contact.control === control)
        )
          contacts.delete(id);
      }
      contacts.delete(e.pointerId);
      if (!tapDevice(e.pointerType)) return;
      const blocked = ink.blocksControls(e.pointerType);
      contacts.set(e.pointerId, { control, x: e.clientX, y: e.clientY, blocked, startedAt: now });
      if (blocked) block(e);
    },
    onPointerMoveCapture(e: PointerEvent) {
      const contact = contacts.get(e.pointerId);
      if (!contact || contact.releasedAt !== undefined) return;
      contact.blocked ||=
        Math.hypot(e.clientX - contact.x, e.clientY - contact.y) > 12 ||
        ink.blocksControls(e.pointerType);
      if (contact.blocked) block(e);
    },
    onPointerUpCapture: (e: PointerEvent) => finish(e),
    onPointerCancelCapture: (e: PointerEvent) => finish(e, true),
    onMouseDownCapture(e: MouseEvent) {
      // A delayed compatibility mousedown can focus a field before click runs.
      const control = controlAt(e.target);
      if (control && recentContact(control)?.[1].blocked) block(e);
    },
    onClickCapture(e: MouseEvent) {
      const control = controlAt(e.target);
      if (!control) return;
      const event = e.nativeEvent as globalThis.PointerEvent;
      // Keyboard and mouse activation continue to work during Pencil use.
      if (!tapDevice(event.pointerType) && e.detail === 0) return;
      if (tapDevice(event.pointerType)) {
        const contact = contacts.get(event.pointerId);
        contacts.delete(event.pointerId);
        if (
          !contact ||
          contact.control !== control ||
          contact.blocked ||
          ink.blocksControls(event.pointerType)
        )
          block(e);
        return;
      }
      // Older Safari dispatches a MouseEvent after a touch or stylus contact.
      const recent = recentContact(control);
      if (recent) {
        const [id, contact] = recent;
        contacts.delete(id);
        if (contact.blocked) block(e);
        return;
      }
      if (event.pointerType !== 'mouse' && ink.blocksControls('')) block(e);
    },
    onContextMenuCapture(e: MouseEvent) {
      if (controlAt(e.target) && ink.blocksControls('touch')) block(e);
    },
  };
}
