import { describe, expect, it } from 'vitest';
import { panVelocity, recordPan } from './touch-momentum';
import type { PanHistory } from './touch-momentum';

describe('one-finger scroll velocity', () => {
  it('uses the direction and speed of recent motion', () => {
    const samples: PanHistory = [];
    recordPan(samples, { x: 0, y: 0 }, 0);
    recordPan(samples, { x: 0, y: -38 }, 16);
    recordPan(samples, { x: 0, y: -80 }, 32);
    expect(panVelocity(samples, 39)).toEqual({ x: 0, y: -2.5 });
    expect(panVelocity(samples, 111)).toBeUndefined();
  });

  it('ignores tiny drags and an isolated position sample', () => {
    const samples = [
      { x: 0, y: 0, time: 0 },
      { x: 0, y: -2, time: 16 },
    ];
    expect(panVelocity(samples, 20)).toBeUndefined();
    recordPan(samples, { x: 0, y: -5 }, 32);
    expect(panVelocity(samples, 39)).toBeUndefined();
  });

  it('bounds the fling speed and ignores motion older than the sampling window', () => {
    const samples: PanHistory = [];
    for (let i = 0; i < 40; i++) recordPan(samples, { x: 30 * i, y: 30 * i }, i * 8);
    const v = panVelocity(samples, 40 * 8)!;
    expect(samples.length).toBeLessThanOrEqual(12);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(3.9);
    for (let i = 40; i <= 55; i++) recordPan(samples, { x: 30 * 39, y: 30 * 39 }, i * 8);
    expect(panVelocity(samples, 56 * 8)).toBeUndefined();
  });
});
