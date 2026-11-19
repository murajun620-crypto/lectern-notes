import { expect, it, vi } from 'vitest';
import { createPencilDiagnostics } from './pencil-diagnostics';

it('keeps all events in a short session and the newest events when the buffer fills', () => {
  vi.stubGlobal('__APP_VERSION__', 'test');
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  try {
    const diagnostics = createPencilDiagnostics();
    const add = (pointerId: number) =>
      diagnostics.finishStroke({
        pointerId,
        pointCount: 2,
        recoveredEndpoint: false,
        dx: 4,
        dy: 0,
      });
    for (let id = 0; id < 2986; id++) add(id);
    const short = JSON.parse(diagnostics.report());
    expect(short.omitted).toBe(0);
    expect(short.events.map((event: { pointerId: number }) => event.pointerId)).toEqual(
      Array.from({ length: 2986 }, (_, id) => id),
    );
    for (let id = 2986; id < 8201; id++) add(id);
    const long = JSON.parse(diagnostics.report());
    expect(long.omitted).toBe(9);
    expect(long.events.map((event: { pointerId: number }) => event.pointerId)).toEqual(
      Array.from({ length: 8192 }, (_, i) => i + 9),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
