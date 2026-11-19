type Contact = { clientX: number; clientY: number };
type StylusTouch = Touch & { touchType?: string; force?: number };

const eventLimit = 800;
const round = (value: number) => Math.round(value * 10) / 10;

export function createPencilDiagnostics() {
  const startedAt = performance.now();
  const events: Record<string, unknown>[] = [];
  let omitted = 0;

  const record = (event: Record<string, unknown>) => {
    if (events.length < eventLimit)
      events.push({ receivedMs: round(performance.now() - startedAt), ...event });
    else omitted++;
  };

  const attach = (stage: HTMLElement) => {
    const pointerStarts = new Map<number, Contact>();
    const touchStarts = new Map<number, Contact>();
    const relative = (contact: Contact, start: Contact) => ({
      dx: round(contact.clientX - start.clientX),
      dy: round(contact.clientY - start.clientY),
    });
    const pointer = (event: PointerEvent) => {
      if (event.pointerType !== 'pen') return;
      const { pointerId: id, type } = event;
      if (type === 'pointerdown') pointerStarts.set(id, event);
      const start = pointerStarts.get(id);
      if (!start) return;
      const coalesced = event.getCoalescedEvents?.() ?? [];
      record({
        type,
        id,
        timeMs: round(event.timeStamp - startedAt),
        ...relative(event, start),
        pressure: event.pressure,
        buttons: event.buttons,
        coalescedCount: coalesced.length,
        coalesced: coalesced.slice(-16).map((sample) => ({
          type: sample.type,
          timeMs: round(sample.timeStamp - startedAt),
          ...relative(sample, start),
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
        if (type === 'touchstart' && touchType === 'stylus') touchStarts.set(id, contact);
        const start = touchStarts.get(id) ?? (touchType === 'stylus' ? contact : undefined);
        if (!start) continue;
        record({
          type,
          id,
          timeMs: round(event.timeStamp - startedAt),
          ...relative(contact, start),
          force,
          startedInStage: touchStarts.has(id),
          activeTouches: event.touches.length,
        });
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
      stage.addEventListener(name, pointer, { capture: true, passive: true });
    for (const name of touchEvents)
      stage.addEventListener(name, touch, { capture: true, passive: true });
    return () => {
      for (const name of pointerEvents) stage.removeEventListener(name, pointer, true);
      for (const name of touchEvents) stage.removeEventListener(name, touch, true);
    };
  };

  return {
    attach,
    finishStroke(details: {
      pointerId?: number;
      touchId?: number;
      pointCount: number;
      recoveredEndpoint: boolean;
    }) {
      record({ type: 'strokeFinished', ...details });
    },
    report: () =>
      JSON.stringify(
        {
          version: __APP_VERSION__,
          standalone: window.matchMedia('(display-mode: standalone)').matches,
          omitted,
          events,
        },
        null,
        2,
      ),
  };
}

export type PencilDiagnostics = ReturnType<typeof createPencilDiagnostics>;
