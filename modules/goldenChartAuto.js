// modules/goldenChartAuto.js
// Golden Chart Auto Renderer (complete, advanced)
// - Single entry: renderGoldenChartFromFile(canvas, file, options)
// - Exports helpers for testing and reuse
// - Requires core.js exports: parseChartText, decideTrade
// - Requires Tesseract available on window.Tesseract
//
// Usage:
// import { renderGoldenChartFromFile } from './modules/goldenChartAuto.js';
// await renderGoldenChartFromFile(document.getElementById('sim-canvas'), droppedFile, { maxDim: 1600 });
//
// Notes:
// - This module focuses on robust OCR, axis extraction, price->Y inference, and cinematic rendering.
// - It returns a structured result: { ok, parsed, decision, ocr, priceToYConfidence, meta }
// - It saves gf_data and gf_decision to localStorage (keeps compatibility with options page).

/* eslint-disable no-console */
import { parseChartText, decideTrade } from './core.js';

const DEFAULTS = {
  maxDim: 1600,
  ocrRetries: 2,
  ocrRetryDelay: 600,
  devicePixelRatio: window.devicePixelRatio || 1,
  axisLeftZone: 0.18,
  axisRightZone: 0.82
};

const Tesseract = window.Tesseract;
if (!Tesseract) console.warn('Tesseract not found on window. Make sure the CDN script is loaded before this module.');

function nowISO() { return new Date().toISOString(); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function safeNum(v, fallback = null) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// -----------------------------
// Image loading & preprocessing
// -----------------------------
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

function preprocessImageToCanvas(img, maxDim = DEFAULTS.maxDim) {
  const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);

  // mild grayscale + contrast stretch to help OCR
  try {
    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      sum += lum;
    }
    const mean = sum / (d.length / 4);
    const contrast = 1.12;
    for (let i = 0; i < d.length; i += 4) {
      let lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      lum = (lum - mean) * contrast + mean;
      lum = clamp(Math.round(lum), 0, 255);
      d[i] = d[i + 1] = d[i + 2] = lum;
    }
    ctx.putImageData(id, 0, 0);
  } catch (e) {
    // Some browsers may restrict getImageData for cross-origin images; ignore if fails
    console.warn('preprocessImageToCanvas: imageData processing failed', e);
  }

  return canvas;
}

// -----------------------------
// OCR with retries
// -----------------------------
async function ocrCanvasWithRetries(canvas, retries = DEFAULTS.ocrRetries, delay = DEFAULTS.ocrRetryDelay) {
  if (!Tesseract) throw new Error('Tesseract not available');
  let attempt = 0;
  let lastErr = null;
  while (attempt <= retries) {
    try {
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      const res = await Tesseract.recognize(blob, 'eng', {
        tessedit_char_whitelist: '0123456789.,%$-–—ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',
        preserve_interword_spaces: '1'
      });
      const words = res?.data?.words || [];
      const avgConf = words.length ? (words.reduce((s, w) => s + (w.confidence || 0), 0) / words.length) : 0;
      return { text: res?.data?.text || '', words, avgConf, raw: res };
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt <= retries) await sleep(delay);
    }
  }
  throw lastErr;
}

// -----------------------------
// OCR word normalization
// -----------------------------
function normalizeWords(words) {
  return (words || []).map(w => {
    if (!w) return null;
    if (w.bbox) return { text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, conf: w.confidence || 0 };
    if (w.x !== undefined) return { text: w.text, x0: w.x, y0: w.y, x1: w.x + (w.w || 0), y1: w.y + (w.h || 0), conf: w.confidence || 0 };
    return null;
  }).filter(Boolean);
}

// -----------------------------
// Axis extraction & mapping
// -----------------------------
const NUM_RE = /[-+]?\$?\d{1,3}(?:[,\d]{0,})?(?:\.\d+)?%?/;

function extractAxisNumbers(words, canvasW, opts = DEFAULTS) {
  const leftZone = canvasW * opts.axisLeftZone;
  const rightZone = canvasW * opts.axisRightZone;
  const left = [], right = [];
  for (const w of words) {
    const t = (w.text || '').replace(/\s+/g, '');
    if (!t) continue;
    const m = t.match(NUM_RE);
    if (!m) continue;
    const raw = m[0].replace(/[$,%]/g, '').replace(/,/g, '');
    const val = Number(raw);
    if (!Number.isFinite(val)) continue;
    const cx = (w.x0 + w.x1) / 2;
    const cy = (w.y0 + w.y1) / 2;
    if (cx <= leftZone) left.push({ val, x: cx, y: cy, raw: w.text, conf: w.conf });
    else if (cx >= rightZone) right.push({ val, x: cx, y: cy, raw: w.text, conf: w.conf });
  }
  left.sort((a, b) => a.y - b.y);
  right.sort((a, b) => a.y - b.y);
  return { left, right };
}

function buildLinearPriceToY(axisNums, scaleY = 1) {
  if (!axisNums || axisNums.length < 2) return null;
  const n = axisNums.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const p of axisNums) {
    const x = p.val;
    const y = p.y * scaleY;
    sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
  }
  const denom = (n * sumXX - sumX * sumX);
  if (Math.abs(denom) < 1e-9) return null;
  const a = (n * sumXY - sumX * sumY) / denom;
  const b = (sumY - a * sumX) / n;
  return (price) => a * price + b;
}

// Fallback mapping using parsed dayHigh/dayLow or price heuristics
function fallbackPriceToY(parsed, canvasH) {
  const price = safeNum(parsed.price, null);
  const high = safeNum(parsed.dayHigh, null);
  const low = safeNum(parsed.dayLow, null);
  if (high != null && low != null && high !== low) {
    const topY = canvasH * 0.08;
    const bottomY = canvasH * 0.92;
    return (p) => {
      const t = (high - p) / (high - low);
      return topY + t * (bottomY - topY);
    };
  }
  if (price != null) {
    const centerY = canvasH / 2;
    const pxPerUnit = Math.max(0.5, Math.abs(price) * 0.01);
    return (p) => centerY - (p - price) * pxPerUnit;
  }
  return null;
}

// Confidence metric for mapping
function computeMappingConfidence(axisNums) {
  if (!axisNums || axisNums.length < 2) return 0;
  // confidence based on number of axis labels and spread of y positions
  const countScore = Math.min(1, axisNums.length / 6); // saturates at 6 labels
  const ys = axisNums.map(a => a.y);
  const spread = (Math.max(...ys) - Math.min(...ys)) || 1;
  const spreadScore = clamp(spread / 200, 0, 1); // more vertical spread -> better
  const avgConf = axisNums.reduce((s, a) => s + (a.conf || 0), 0) / axisNums.length;
  const confScore = clamp((avgConf / 100) * 0.6 + countScore * 0.2 + spreadScore * 0.2, 0, 1);
  return Math.round(confScore * 100);
}

// -----------------------------
// Rendering helpers (procedural gold visuals)
// -----------------------------
function fitImageToCanvas(imgW, imgH, canvasW, canvasH) {
  const imgRatio = imgW / imgH;
  const canvasRatio = canvasW / canvasH;
  let w, h, x, y;
  if (imgRatio > canvasRatio) {
    w = canvasW;
    h = Math.round(w / imgRatio);
    x = 0;
    y = Math.round((canvasH - h) / 2);
  } else {
    h = canvasH;
    w = Math.round(h * imgRatio);
    y = 0;
    x = Math.round((canvasW - w) / 2);
  }
  return { x, y, w, h };
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function applyVignette(ctx, w, h, strength = 0.45) {
  const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.8);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, `rgba(0,0,0,${clamp(strength, 0, 1)})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

function paintCandleTexture(ctx, x, y, w, h, fillColor, edgeColor, glossColor) {
  ctx.save();
  ctx.fillStyle = fillColor;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 0.06;
  for (let i = 0; i < Math.ceil(w); i += 2) {
    ctx.fillStyle = `rgba(0,0,0,${0.02 + (i % 4) * 0.005})`;
    ctx.fillRect(x + i, y, 1, h);
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = edgeColor; ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = glossColor; ctx.globalAlpha = 0.06;
  ctx.fillRect(x, y, w, Math.max(2, Math.round(h * 0.18)));
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

function applyGlow(ctx, y, w, color, radius = 12) {
  ctx.save();
  const grad = ctx.createLinearGradient(0, y - radius, 0, y + radius);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.45, `${color}22`);
  grad.addColorStop(0.5, `${color}66`);
  grad.addColorStop(0.55, `${color}22`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, y - radius, w, radius * 2);
  ctx.restore();
}

function drawPriceLine(ctx, w, h, priceToY, price, color, accent, label) {
  if (price == null || typeof priceToY !== 'function') return;
  let y;
  try { y = priceToY(price); } catch (e) { y = h / 2; }
  y = clamp(y, 0, h);
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.setLineDash([8, 6]);
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y - 3); ctx.lineTo(w, y - 3); ctx.stroke();
  ctx.font = '12px system-ui, Arial'; ctx.textBaseline = 'middle';
  const text = `${label} ${Number(price).toFixed(2)}`; const metrics = ctx.measureText(text);
  const pad = 8; const boxW = metrics.width + pad * 2; const boxH = 20;
  const boxX = w - boxW - 12; const boxY = clamp(y - boxH / 2, 6, h - boxH - 6);
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = color; ctx.fillText(text, boxX + pad, boxY + boxH / 2 + 1);
  applyGlow(ctx, y, w, accent, 18);
  ctx.restore();
}

// -----------------------------
// Main entry: renderGoldenChartFromFile
// -----------------------------
export async function renderGoldenChartFromFile(canvas, file, options = {}) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  if (!canvas || !(canvas instanceof HTMLCanvasElement)) throw new Error('Canvas element required');
  if (!file) throw new Error('File required');

  // 1) load image
  const img = await loadImageFromFile(file);

  // 2) preprocess for OCR
  const preCanvas = preprocessImageToCanvas(img, opts.maxDim);

  // 3) OCR
  const ocr = await ocrCanvasWithRetries(preCanvas, opts.ocrRetries, opts.ocrRetryDelay);

  // 4) parse text using core.parseChartText
  const parsed = parseChartText(ocr.text || '');

  // 5) normalize words and extract axis numbers
  const normWords = normalizeWords(ocr.words || []);
  const axis = extractAxisNumbers(normWords, preCanvas.width, opts);
  const axisNums = (axis.right.length >= axis.left.length) ? axis.right : axis.left;

  // 6) map axis y from preCanvas to final canvas CSS size
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const scaleY = cssH / preCanvas.height;
  const axisNormalized = axisNums.map(n => ({ val: n.val, y: n.y * scaleY, conf: n.conf }));

  // 7) build price->y mapping
  let priceToY = null;
  let mappingSource = 'none';
  let mappingConfidence = 0;
  if (axisNormalized.length >= 2) {
    priceToY = buildLinearPriceToY(axisNormalized, 1);
    mappingSource = 'axis';
    mappingConfidence = computeMappingConfidence(axisNormalized);
  }

  // 8) fallback mapping
  if (!priceToY) {
    priceToY = fallbackPriceToY(parsed, cssH);
    mappingSource = 'fallback';
    mappingConfidence = mappingConfidence || (parsed.price ? 40 : 10);
  }

  // 9) run rule engine
  const decision = decideTrade(parsed, { context: { ocrAvgConf: ocr.avgConf } });

  // 10) render to canvas
  const ctx = canvas.getContext('2d', { alpha: false });
  canvas.width = Math.round(cssW * opts.devicePixelRatio);
  canvas.height = Math.round(cssH * opts.devicePixelRatio);
  ctx.setTransform(opts.devicePixelRatio, 0, 0, opts.devicePixelRatio, 0, 0);

  // background
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, cssW, cssH);

  // faint original image for texture
  const fit = fitImageToCanvas(img.width, img.height, cssW, cssH);
  ctx.globalAlpha = 0.06;
  ctx.drawImage(img, fit.x, fit.y, fit.w, fit.h);
  ctx.globalAlpha = 1;

  // gold overlay gradient
  const gold = hexToRgb('#d4af37'), accent = hexToRgb('#ffd86b');
  const g = ctx.createLinearGradient(0, 0, cssW, cssH);
  g.addColorStop(0, `rgba(${gold.r},${gold.g},${gold.b},0.06)`);
  g.addColorStop(0.5, `rgba(${accent.r},${accent.g},${accent.b},0.08)`);
  g.addColorStop(1, `rgba(${gold.r},${gold.g},${gold.b},0.05)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cssW, cssH);

  // procedural candle strip for texture
  const stripH = Math.round(cssH * 0.28);
  const stripY = Math.round(cssH * 0.36);
  const candleW = Math.max(6, Math.round(cssW / 60));
  for (let cx = 12; cx < cssW - 12; cx += candleW + 6) {
    const ch = Math.round(stripH * (0.6 + Math.random() * 0.8));
    const cy = stripY + Math.round((stripH - ch) * Math.random());
    const fillColor = `rgba(${mix(gold.r, accent.r, Math.random() * 0.6)},${mix(gold.g, accent.g, Math.random() * 0.6)},${mix(gold.b, accent.b, Math.random() * 0.6)},${0.18 + Math.random() * 0.12})`;
    const edgeColor = `rgba(${mix(gold.r, 0, 0.2)},${mix(gold.g, 0, 0.2)},${mix(gold.b, 0, 0.2)},0.6)`;
    const gloss = `rgba(${accent.r},${accent.g},${accent.b},0.12)`;
    paintCandleTexture(ctx, cx, cy, candleW, ch, fillColor, edgeColor, gloss);
  }

  applyVignette(ctx, cssW, cssH, 0.45);

  // draw simulated future path (visualization only)
  try {
    const future = simulateFutureForRender(parsed, decision, 40);
    ctx.strokeStyle = decision.direction === 'call' ? '#3cff9d' : decision.direction === 'put' ? '#ff4b4b' : '#999';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    future.forEach((p, i) => {
      const x = Math.round((i / (future.length - 1 || 1)) * (cssW - 40)) + 20;
      const y = priceToY(p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  } catch (e) {
    console.warn('simulateFutureForRender failed', e);
  }

  // draw entry/stop/target
  drawPriceLine(ctx, cssW, cssH, priceToY, decision.entry, '#3cff9d', '#d4af37', 'ENTRY');
  drawPriceLine(ctx, cssW, cssH, priceToY, decision.stop, '#ff4b4b', '#ff8a8a', 'STOP');
  drawPriceLine(ctx, cssW, cssH, priceToY, decision.target, '#4bb8ff', '#9fdcff', 'TARGET');

  // header
  ctx.fillStyle = '#d4af37';
  ctx.font = '13px system-ui, Arial';
  ctx.fillText(`Golden Chart • ${nowISO()}`, 12, 18);

  // persist parsed & decision for options page
  try {
    localStorage.setItem('gf_data', JSON.stringify(parsed));
    localStorage.setItem('gf_decision', JSON.stringify(decision));
    localStorage.setItem('gf_last_ocr_confidence', String(ocr.avgConf || 0));
    localStorage.setItem('gf_last_analysis_time', nowISO());
  } catch (e) {
    // ignore storage errors
  }

  // return structured result
  return {
    ok: true,
    parsed,
    decision,
    ocr: { avgConf: ocr.avgConf || 0, raw: ocr.raw },
    priceToYConfidence: mappingConfidence,
    mappingSource,
    meta: {
      axis,
      axisNormalized,
      cssW,
      cssH
    }
  };
}

// -----------------------------
// Small utilities & exports for testing
// -----------------------------
function mix(a, b, t) { return Math.round(a * (1 - t) + b * t); }
function simulateFutureForRender(parsed, decision, steps = 30) {
  // lightweight biased walk for visualization
  const price = safeNum(parsed.price, 100);
  const candles = [];
  if (!decision || !decision.valid) {
    for (let i = 0; i < steps; i++) candles.push(price + (Math.random() - 0.5) * (price * 0.002));
    return candles;
  }
  let current = price;
  const bias = decision.direction === 'call' ? 1 : -1;
  for (let i = 0; i < steps; i++) {
    current += bias * price * 0.003 + (Math.random() - 0.5) * (price * 0.001);
    candles.push(current);
  }
  return candles;
}

// Export additional helpers for unit testing or external use
export function inferPriceToYFromOCRWords(words, canvasW, canvasH, options = {}) {
  const norm = normalizeWords(words || []);
  const axis = extractAxisNumbers(norm, canvasW, options);
  const axisNums = (axis.right.length >= axis.left.length) ? axis.right : axis.left;
  const scaleY = canvasH / (options.preCanvasHeight || canvasH);
  const axisNormalized = axisNums.map(n => ({ val: n.val, y: n.y * scaleY, conf: n.conf }));
  const mapper = axisNormalized.length >= 2 ? buildLinearPriceToY(axisNormalized, 1) : null;
  const confidence = computeMappingConfidence(axisNormalized);
  return { mapper, confidence, axis, axisNormalized };
}
