type Offset = { x: number; y: number };
export type PanHistory = Array<Offset & { time: number }>;

export function recordPan(history: PanHistory, offset: Offset, time: number) {
  const last = history.at(-1);
  const sample = { ...offset, time };
  if (last && time <= last.time) {
    if (time === last.time) history[history.length - 1] = sample;
    return;
  }
  history.push(sample);
  while (history.length > 12 || (history.length > 3 && time - history[1].time > 90))
    history.shift();
}

/** Use recent viewport motion, in CSS pixels per millisecond. */
export function panVelocity(history: PanHistory, releasedAt: number): Offset | undefined {
  if (history.length < 3) return;
  const end = history.at(-1)!;
  const age = Math.max(0, releasedAt - end.time);
  if (age > 75) return;
  const start = history.find((sample) => end.time - sample.time <= 85);
  if (!start || end.time - start.time < 12) return;
  const elapsed = end.time - start.time;
  const x = (end.x - start.x) / elapsed;
  const y = (end.y - start.y) / elapsed;
  const speed = Math.hypot(x, y);
  const releasedSpeed = Math.min(3.9, speed * Math.exp(-Math.max(0, age - 16) / 34));
  if (releasedSpeed < 0.34) return;
  return { x: (x * releasedSpeed) / speed, y: (y * releasedSpeed) / speed };
}
