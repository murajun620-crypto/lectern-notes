import { isPenKind } from './model';
import type { PenKind, Tool } from './model';

/** Leave a short window between letters for the next stroke to take priority. */
export function createInkPriority() {
  let active = false;
  let endedAt = -Infinity;
  return {
    begin: () => {
      active = true;
    },
    end: () => {
      if (!active) return;
      active = false;
      endedAt = performance.now();
    },
    isBusy: () => active || performance.now() - endedAt < 140,
    blocksControls: (pointerType: string) =>
      active || (pointerType === 'touch' && performance.now() - endedAt < 230),
  };
}
export type InkPriority = ReturnType<typeof createInkPriority>;

export type PencilTool = Exclude<Tool, 'hand' | 'text'>;
export const penWidths = [1, 2.5, 4, 7, 10];
export const highlighterWidths = [5, 12.5, 20, 35, 50];
export const toolWidthRanges = {
  penWidth: { min: 0.5, max: 10, step: 0.1, unit: 'pt' },
  highlighterWidth: { min: 1, max: 50, step: 0.1, unit: 'pt' },
  eraserWidth: { min: 1, max: 80, step: 1, unit: 'px' },
} as const;
export type InputPreferences = {
  fingerInk: boolean;
  pencilPressure: boolean;
  palmRejection: boolean;
  twoFingerTap: boolean;
  showFooter: boolean;
  pageMode: 'continuous' | 'single';
  presets: string[];
  highlighterPresets: string[];
  penStyle?: PenKind;
  penWidth: number;
  highlighterWidth: number;
  laserWidth: number;
  eraserWidth: number;
};
export const defaultInputPreferences: InputPreferences = {
  fingerInk: false,
  pencilPressure: false,
  palmRejection: true,
  twoFingerTap: true,
  showFooter: true,
  pageMode: 'continuous',
  presets: ['#183e3a', '#cf4d44', '#447cbd'],
  highlighterPresets: ['#fff200', '#ff45bf', '#a6ff00'],
  penWidth: 2.5,
  highlighterWidth: 12.5,
  laserWidth: 4,
  eraserWidth: 28,
};
function readToolWidth(value: unknown, key: keyof typeof toolWidthRanges): number {
  const { min, max, step } = toolWidthRanges[key];
  const stepsPerUnit = 1 / step;
  return typeof value === 'number' && value >= min && value <= max
    ? Math.round(value * stepsPerUnit) / stepsPerUnit
    : defaultInputPreferences[key];
}
function readPresets(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))
    ? value
    : [...fallback];
}

export function loadInputPreferences(): InputPreferences {
  try {
    const p = JSON.parse(localStorage.getItem('lectern.input') || '{}');
    return {
      fingerInk: p.fingerInk === true,
      pencilPressure: p.pencilPressure === true,
      palmRejection: p.palmRejection !== false,
      twoFingerTap: p.twoFingerTap !== false,
      showFooter: p.showFooter !== false,
      pageMode: p.pageMode === 'single' ? 'single' : 'continuous',
      penStyle: isPenKind(p.penStyle) ? p.penStyle : undefined,
      penWidth: readToolWidth(p.penWidth, 'penWidth'),
      highlighterWidth: readToolWidth(p.highlighterWidth, 'highlighterWidth'),
      laserWidth: [2, 4, 6, 8, 12].includes(p.laserWidth) ? p.laserWidth : 4,
      eraserWidth: readToolWidth(p.eraserWidth, 'eraserWidth'),
      presets: readPresets(p.presets, defaultInputPreferences.presets),
      highlighterPresets: readPresets(
        p.highlighterPresets,
        defaultInputPreferences.highlighterPresets,
      ),
    };
  } catch {
    return defaultInputPreferences;
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
  private pens = new Set<number | symbol>();
  private touches = new Set<number>();
  private blocked = new Set<number>();
  private lastPen = -Infinity;
  private lastRejectedClick = -Infinity;
  rejectsGeometry(width: number, height: number, now: number, enabled: boolean) {
    // Contact width alone cannot distinguish a finger from a palm. Only use a
    // conservative size heuristic shortly after real Pencil activity.
    return enabled && now - this.lastPen < 1500 && Math.max(width, height) >= 80;
  }
  penDown(id: number | symbol, now: number) {
    this.pens.add(id);
    this.lastPen = now;
    for (const touch of this.touches) this.blocked.add(touch);
    this.touches.clear();
  }
  penUp(id: number | symbol, now: number) {
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
