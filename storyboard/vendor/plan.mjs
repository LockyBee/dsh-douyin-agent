// Derived from SAOS-3624/dsh-video-storyboard src/plan.js; MIT, see LICENSE.
export const PIXEL_BUDGET = 640_000;
export const IMAGE_TOKEN_CAP = 384;
export const MIN_CELL_W = 240;
export const MIN_CELL_H = 135;
export const MAX_SHEETS = 4;
export const DEFAULT_ASPECT = 16 / 9;

/** Content-classification thresholds. Kept in one place so the manifest can report them. */
export const PLAN_THRESHOLDS = Object.freeze({
  musicLufs: -18,
  musicSpeechRate: 1,
  speechRateCut: 3,
});

/** 画布比例 = (cols / rows) × 源比例。方形宫格才会还原源比例。 */
export const canvasAspect = (cols, rows, aspect) => (cols / rows) * aspect;

/**
 * 给定格数 n 与源比例，选一组 (cols, rows) 使画布比例最接近源比例。
 * - 允许 cols*rows >= n（多余位置补灰格），所以非平方数也不会被硬塞成怪形状
 * - 同分时略偏袒"更高"的画布：超宽画布被方形/16:9 编码器裁掉的部分更多
 */
export function bestLayout(n, aspect = DEFAULT_ASPECT) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be a positive integer, got ${n}`);
  if (!(aspect > 0)) throw new RangeError(`aspect must be > 0, got ${aspect}`);
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const canvas = canvasAspect(cols, rows, aspect);
    let cost = Math.abs(Math.log(canvas / aspect));
    if (canvas > aspect) cost += 0.12;
    const padded = cols * rows - n;
    const key = [Math.round((cost + 0.15 * padded) * 1e6) / 1e6, cols * rows];
    if (best === null || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) {
      best = { key, cols, rows };
    }
  }
  const { cols, rows } = best;
  return { cols, rows, capacity: cols * rows, canvasAspect: canvasAspect(cols, rows, aspect) };
}

