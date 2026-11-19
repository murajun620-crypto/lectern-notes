type Contact = { clientX: number; clientY: number };
type Origin = { contact: Contact; fromMove: boolean };
type StylusTouch = Touch & { touchType?: string; force?: number };

const eventLimit = 8192;
const round = (value: number) => Math.round(value * 10) / 10;

export function createPencilDiagnostics() {
  const startedAt = performance.now();
  const events: Record<string, unknown>[] = [];
  let omitted = 0;
  let oldest = 0;

  const record = (event: Record<string, unknown>) => {
    const entry = { receivedMs: round(performance.now() - startedAt), ...event };
    if (events.length < eventLimit) {
      events.push(entry);
      return;
    }
    events[oldest] = entry;
    oldest = (oldest + 1) % eventLimit;
    omitted++;
  };

  const attach = (stage: HTMLElement) => {
    const document = stage.ownerDocument;
    const pointerStarts = new Map<number, Origin>();
    const touchStarts = new Map<number, Origin>();
    const inStage = (target: EventTarget | null) =>
      target instanceof Node && stage.contains(target);
    const relative = (contact: Contact, start: Contact) => ({
      dx: round(contact.clientX - start.clientX),
      dy: round(contact.clientY - start.clientY),
    });
    const pointer = (event: PointerEvent) => {
      const { pointerId: id, pointerType, type } = event;
      if (pointerType !== 'pen' && pointerType !== 'touch') return;
      const entry = {
        type,
        id,
        pointerType,
        inStage: inStage(event.target),
        timeMs: round(event.timeStamp - startedAt),
      };
      if (pointerType === 'pen' && entry.inStage) {
        if (type === 'pointerdown') pointerStarts.set(id, { contact: event, fromMove: false });
        else if (type === 'pointermove' && event.buttons & 1 && !pointerStarts.has(id))
          pointerStarts.set(id, { contact: event, fromMove: true });
      }
      const start = pointerStarts.get(id) ?? touchStarts.get(id);
      if (!start || !entry.inStage) {
        if (type !== 'pointermove') record(entry);
        if (type === 'pointerup' || type === 'pointercancel') pointerStarts.delete(id);
        return;
      }
      const coalesced = event.getCoalescedEvents?.() ?? [];
      record({
        ...entry,
        ...relative(event, start.contact),
        ...(start.fromMove && { originFromMove: true }),
        pressure: event.pressure,
        buttons: event.buttons,
        coalescedCount: coalesced.length,
        coalesced: coalesced.slice(-16).map((sample) => ({
          type: sample.type,
          timeMs: round(sample.timeStamp - startedAt),
          ...relative(sample, start.contact),
          pressure: sample.pressure,
          buttons: sample.buttons,
        })),
      });
      if (type === 'pointerup' || type === 'pointercancel') pointerStarts.delete(id);
    };
    const touch = (event: TouchEvent) => {
      for (const contact of Array.from(event.changedTouches) as StylusTouch[]) {
        const { identifier: id, touchType, force } = contact;
        const { type } = event;
        const entry = {
          type,
          id,
          touchType: touchType ?? 'unknown',
          inStage: inStage(contact.target ?? event.target),
          timeMs: round(event.timeStamp - startedAt),
          activeTouches: event.touches.length,
        };
        if (touchType === 'stylus' && entry.inStage) {
          if (type === 'touchstart') touchStarts.set(id, { contact, fromMove: false });
          else if (type === 'touchmove' && !touchStarts.has(id))
            touchStarts.set(id, { contact, fromMove: true });
        }
        const start = touchStarts.get(id);
        if ((start || touchType === 'stylus') && entry.inStage) {
          record({
            ...entry,
            ...relative(contact, start?.contact ?? contact),
            ...(start?.fromMove && { originFromMove: true }),
            force,
            startedInStage: !!start && !start.fromMove,
          });
        } else if (type !== 'touchmove') record(entry);
        if (type === 'touchend' || type === 'touchcancel') touchStarts.delete(id);
      }
    };
    const pointerEvents = [
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'lostpointercapture',
    ] as const;
    const touchEvents = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const;
    for (const name of pointerEvents)
      document.addEventListener(name, pointer, { capture: true, passive: true });
    for (const name of touchEvents)
      document.addEventListener(name, touch, { capture: true, passive: true });
    return () => {
      for (const name of pointerEvents) document.removeEventListener(name, pointer, true);
      for (const name of touchEvents) document.removeEventListener(name, touch, true);
    };
  };

  return {
    attach,
    finishStroke(details: {
      pointerId?: number;
      touchId?: number;
      pointCount: number;
      recoveredEndpoint: boolean;
      recoveredStart?: 'pointermove' | 'touchmove';
      dx: number;
      dy: number;
    }) {
      record({ ...details, type: 'strokeFinished', dx: round(details.dx), dy: round(details.dy) });
    },
    report: () =>
      JSON.stringify(
        {
          version: __APP_VERSION__,
          standalone: window.matchMedia('(display-mode: standalone)').matches,
          omitted,
          events: oldest ? [...events.slice(oldest), ...events.slice(0, oldest)] : events,
        },
        null,
        2,
      ),
  };
}

export type PencilDiagnostics = ReturnType<typeof createPencilDiagnostics>;
