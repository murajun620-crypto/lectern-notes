import type { Tool } from './model';

export type PencilTool = Exclude<Tool, 'hand'>;
export type InputPreferences = {
  fingerInk: boolean;
  palmRejection: boolean;
  twoFingerTap: boolean;
  presets: string[];
  laserWidth: number;
};
export const defaultInputPreferences: InputPreferences = {
  fingerInk: false,
  palmRejection: true,
  twoFingerTap: true,
  presets: ['#183e3a', '#cf4d44', '#447cbd'],
  laserWidth: 4,
};
export function loadInputPreferences(): InputPreferences {
  try {
    const p = JSON.parse(localStorage.getItem('lectern.input') || '{}');
    return {
      fingerInk: p.fingerInk === true,
      palmRejection: p.palmRejection !== false,
      twoFingerTap: p.twoFingerTap !== false,
      laserWidth: [2, 4, 6, 8, 12].includes(p.laserWidth) ? p.laserWidth : 4,
      presets:
        Array.isArray(p.presets) &&
        p.presets.length === 3 &&
        p.presets.every((c: unknown) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))
          ? p.presets
          : [...defaultInputPreferences.presets],
    };
  } catch {
    return { ...defaultInputPreferences, presets: [...defaultInputPreferences.presets] };
  }
}
export function effectiveTool(
  tool: Tool,
  pencilTool: PencilTool,
  pointerType: string,
  fingerInk: boolean,
): Tool {
  return pointerType === 'pen' && !fingerInk && tool === 'hand' ? pencilTool : tool;
}
/** Quarantine rejected contacts until they lift; a resting palm must never become a pan later. */
export class PalmGuard {
  private pens = new Set<number>();
  private touches = new Set<number>();
  private blocked = new Set<number>();
  private lastPen = -Infinity;
  private lastRejectedClick = -Infinity;
  rejectsGeometry(width: number, height: number, now: number, enabled: boolean) {
    // Contact width alone cannot distinguish a finger from a palm. Only use a
    // conservative size heuristic shortly after real Pencil activity.
    return enabled && now - this.lastPen < 1500 && Math.max(width, height) >= 80;
  }
  penDown(id: number, now: number) {
    this.pens.add(id);
    this.lastPen = now;
    for (const touch of this.touches) this.blocked.add(touch);
    this.touches.clear();
  }
  penUp(id: number, now: number) {
    if (this.pens.delete(id)) this.lastPen = now;
  }
  touchDown(
    id: number,
    width: number,
    height: number,
    now: number,
    enabled: boolean,
    rejectRecent = true,
  ) {
    if (
      this.blocked.has(id) ||
      (enabled &&
        (this.pens.size > 0 ||
          (rejectRecent && now - this.lastPen < 350) ||
          this.rejectsGeometry(width, height, now, enabled)))
    ) {
      this.blocked.add(id);
      return false;
    }
    this.touches.add(id);
    return true;
  }
  allowsTouch(id: number) {
    return this.touches.has(id) && !this.blocked.has(id);
  }
  touchUp(id: number, now?: number) {
    this.touches.delete(id);
    if (this.blocked.has(id) && now !== undefined) this.lastRejectedClick = now;
    this.blocked.delete(id);
  }
  blocksClick(pointerType: string, width: number, height: number, now: number, enabled: boolean) {
    return (
      pointerType === 'touch' &&
      enabled &&
      (this.pens.size > 0 ||
        now - this.lastPen < 350 ||
        now - this.lastRejectedClick < 350 ||
        this.rejectsGeometry(width, height, now, enabled))
    );
  }
  blocksNavigation(_now: number, enabled: boolean) {
    return enabled && (this.pens.size > 0 || this.blocked.size > 0);
  }
  reset(_now: number) {
    this.pens.clear();
    this.touches.clear();
    this.blocked.clear();
    this.lastPen = -Infinity;
    this.lastRejectedClick = -Infinity;
  }
}
