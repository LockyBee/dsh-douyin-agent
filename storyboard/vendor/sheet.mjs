// Derived from SAOS-3624/dsh-video-storyboard src/sheet.js; MIT, see LICENSE.
export const BACKGROUND = [18, 18, 20];
export const PAD_FILL = [42, 42, 46];
export const PAD_GLYPH = [110, 110, 116];
export const BADGE_BG = [0, 0, 0];
export const BADGE_FG = [255, 235, 59];
export const GUTTER = 4;
export const BADGE_ALPHA = 0.85;

/** 5×7 点阵，只有 0-9。scale 必须是整数，保证放大后边缘锐利。 */
export const DIGITS = {
  0: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

export const DIGIT_W = 5;
export const DIGIT_H = 7;

/**
 * 画布尺寸：整图面积 <= budget，格宽高按剩余空间均分。
 * @returns {{width:number,height:number,cellW:number,cellH:number}}
 */
export function layoutCanvas(cols, rows, cellAspect, budget = 640_000, gutter = GUTTER) {
  const aspect = (cols * cellAspect) / rows;
  const gw = Math.sqrt(budget * aspect);
  const gh = gw / aspect;
  const cellW = Math.max(1, Math.floor((gw - gutter * (cols + 1)) / cols));
  const cellH = Math.max(1, Math.floor((gh - gutter * (rows + 1)) / rows));
  return {
    width: cols * cellW + gutter * (cols + 1),
    height: rows * cellH + gutter * (rows + 1),
    cellW,
    cellH,
  };
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** 在 RGB 画布上填一块矩形（支持 alpha 混合） */
export function fillRect(buf, width, height, x, y, w, h, color, alpha = 1) {
  const [r, g, b] = color;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  for (let py = y0; py < y1; py++) {
    let idx = (py * width + x0) * 3;
    for (let px = x0; px < x1; px++) {
      if (alpha >= 1) {
        buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b;
      } else {
        buf[idx] = clamp255(buf[idx] * (1 - alpha) + r * alpha);
        buf[idx + 1] = clamp255(buf[idx + 1] * (1 - alpha) + g * alpha);
        buf[idx + 2] = clamp255(buf[idx + 2] * (1 - alpha) + b * alpha);
      }
      idx += 3;
    }
  }
}

/** 用点阵字形画一个字符串（只支持 0-9 与 "-"），返回实际占用尺寸 */
export function drawGlyphs(buf, width, height, text, x, y, scale, color) {
  let cursor = x;
  for (const ch of String(text)) {
    if (ch === '-') {
      fillRect(buf, width, height, cursor, y + Math.floor(DIGIT_H * scale * 0.6),
        DIGIT_W * scale, Math.max(1, scale), color);
      cursor += (DIGIT_W + 1) * scale;
      continue;
    }
    const glyph = DIGITS[ch];
    if (!glyph) continue;
    for (let row = 0; row < DIGIT_H; row++) {
      for (let col = 0; col < DIGIT_W; col++) {
        if (glyph[row][col] === '1') {
          fillRect(buf, width, height, cursor + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursor += (DIGIT_W + 1) * scale;
  }
  return { width: cursor - x, height: DIGIT_H * scale };
}

/**
 * 字形的整数缩放比：字号约占格高 22%，同时不超过格宽的 30%（两位编号时尤其重要）。
 * 大一点更抗压缩——低分辨率下"认一个字符"比"数格子"稳得多。
 */
export function badgeScale(cellH, cellW = Infinity, digits = 1, ratio = 0.18) {
  const byHeight = Math.floor((cellH * ratio) / DIGIT_H);
  const byWidth = Number.isFinite(cellW)
    ? Math.floor((cellW * 0.26) / (Math.max(1, digits) * (DIGIT_W + 1)))
    : byHeight;
  return Math.max(2, Math.min(byHeight, byWidth));
}

/**
 * 在一格里画编号徽标（黑底 + 黄字，左上角固定位置）。
 * 不透明优先：半透明底块在白板/雪景上会直接消失（实测见设计方案 §3.5）。
 */
export function drawBadge(buf, width, height, x, y, cellW, cellH, label, ratio = 0.18) {
  const digits = String(label).length;
  const scale = badgeScale(cellH, cellW, digits, ratio);
  const pad = Math.max(2, Math.round(cellH * 0.025));
  const textW = digits * (DIGIT_W + 1) * scale - scale;
  const textH = DIGIT_H * scale;
  fillRect(buf, width, height, x, y, textW + pad * 2, textH + pad * 2, BADGE_BG, BADGE_ALPHA);
  drawGlyphs(buf, width, height, label, x + pad, y + pad, scale, BADGE_FG);
  return { w: textW + pad * 2, h: textH + pad * 2 };
}

/** 空位：灰底 + 居中横杠，且绝对不编号 */
export function drawPadding(buf, width, height, x, y, cellW, cellH) {
  fillRect(buf, width, height, x, y, cellW, cellH, PAD_FILL);
  const barW = Math.max(6, Math.round(cellW * 0.32));
  const barH = Math.max(2, Math.round(cellH * 0.03));
  fillRect(buf, width, height,
    x + Math.round((cellW - barW) / 2), y + Math.round((cellH - barH) / 2),
    barW, barH, PAD_GLYPH);
}

/**
 * 把若干帧（rawvideo rgb24）拼成一张画布。
 * @param {{frames:Array<{buffer:Buffer, index:number}|null>, cols:number, rows:number,
 *          cellAspect:number, budget?:number, gutter?:number, burn?:'index'|'none'}} opts
 *   frames 顺序对应格位 1..cols*rows；null = 空位（补灰）
 * @returns {{buffer:Buffer,width:number,height:number,cellW:number,cellH:number}}
 */
export function composeSheet(opts) {
  const {
    frames, cols, rows, cellAspect, budget = 640_000, gutter = GUTTER,
    burn = 'index', badgeRatio = 0.18,
  } = opts;
  if (!Array.isArray(frames)) throw new TypeError('frames must be an array');
  if (frames.length > cols * rows) throw new RangeError('more frames than cells');
  const { width, height, cellW, cellH } = layoutCanvas(cols, rows, cellAspect, budget, gutter);
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = BACKGROUND[0]; buf[i + 1] = BACKGROUND[1]; buf[i + 2] = BACKGROUND[2];
  }

  for (let pos = 0; pos < cols * rows; pos++) {
    const r = Math.floor(pos / cols);
    const c = pos % cols;
    const x = gutter + c * (cellW + gutter);
    const y = gutter + r * (cellH + gutter);
    const frame = frames[pos];
    if (!frame) {
      drawPadding(buf, width, height, x, y, cellW, cellH);
      continue;
    }
    blit(buf, width, height, x, y, cellW, cellH, frame.buffer);
    if (burn !== 'none') drawBadge(buf, width, height, x + 2, y + 2, cellW, cellH, frame.index, badgeRatio);
  }
  return { buffer: buf, width, height, cellW, cellH };
}

/**
 * 把一格摊成 k×k 的小格（rawvideo rgb24），拼成一张 cellW×cellH 的图。
 *
 * 为什么这么做：快闪段里"这一格到底闪了几下"用一张代表帧说不清。把这一格再切成
 * 3×3 或 4×4，同样一张图（同样 384 token）就能交代 9 个或 16 个瞬间。
 * 代价是每个子帧只有 1/k² 的像素 —— 所以调用方必须先确认父格够大（见 chooseSubGrid）。
 *
 * @param {Buffer[]} tiles 长度必须等于 k*k，每个 tileW×tileH（rgb24）
 */
export function tileSubFrames(tiles, k, cellW, cellH) {
  const tileW = Math.floor(cellW / k);
  const tileH = Math.floor(cellH / k);
  const out = Buffer.alloc(cellW * cellH * 3);
  for (let i = 0; i < k * k; i++) {
    const src = tiles[i];
    if (!src) continue;
    const ox = (i % k) * tileW;
    const oy = Math.floor(i / k) * tileH;
    for (let row = 0; row < tileH; row++) {
      src.copy(out, ((oy + row) * cellW + ox) * 3, row * tileW * 3, row * tileW * 3 + tileW * 3);
    }
  }
  return out;
}

/** 把一格 rawvideo（尺寸必须等于 cellW×cellH）贴到画布上 */
export function blit(dst, dstW, dstH, x, y, cellW, cellH, src) {
  const need = cellW * cellH * 3;
  if (src.length < need) throw new RangeError(`frame buffer too small: ${src.length} < ${need}`);
  for (let row = 0; row < cellH; row++) {
    const dy = y + row;
    if (dy < 0 || dy >= dstH) continue;
    const sStart = row * cellW * 3;
    const dStart = (dy * dstW + x) * 3;
    src.copy(dst, dStart, sStart, sStart + cellW * 3);
  }
}

