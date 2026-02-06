// modules/simulator.js
// FULL SINGLE-FILE Advanced Simulator — all logic in one place
// - Self-contained: OCR pipeline, text parsing, detectors, rule engine, decision engine,
//   simulation, golden renderer, Finnhub lookup, UI wiring (drag/drop, paste, file input).
// - Designed to be dropped into your project as modules/simulator.js and used with the provided HTML.
// - NOTE: This file intentionally contains everything inline to avoid cross-file imports.

// -----------------------------
// Configuration & Globals
// -----------------------------
/* FINNHUB API KEY (embedded as requested) */
const FINNHUB_API_KEY = 'd5jjkq1r01qgsosgmj9gd5jjkq1r01qgsosgmja0';

const Tesseract = window.Tesseract;
if (!Tesseract) console.warn('Tesseract not found on window. Ensure the CDN script is loaded before this module.');

const MAX_DIM = 1600;
const OCR_RETRIES = 2;
const OCR_RETRY_DELAY = 600;
const DPI = window.devicePixelRatio || 1;

// DOM IDs (match your HTML)
const FILE_INPUT_ID = 'file-input';
const STATUS_ID = 'sim-status';
const CANVAS_ID = 'sim-canvas';
const OUTPUT_ID = 'sim-output';
const LOG_ID = 'sim-log';

// -----------------------------
// Utilities
// -----------------------------
function nowISO() { return new Date().toISOString(); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function safeNum(v, fallback = null) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function downloadBlob(blob, filename = 'golden-chart.png') {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// -----------------------------
// BASIC HELPERS (copied/embedded from core style)
// -----------------------------
function nearestEven(price) {
  if (!price && price !== 0) return null;
  return Math.round(price / 5) * 5;
}
function nextEvenUp(price) {
  if (!price && price !== 0) return null;
  return Math.ceil(price / 5) * 5;
}
function nextEvenDown(price) {
  if (!price && price !== 0) return null;
  return Math.floor(price / 5) * 5;
}
function dynamicStep(price) {
  if (price <= 0.5) return 0.01;
  if (price <= 5) return 0.05;
  if (price <= 20) return 0.1;
  if (price <= 100) return 0.5;
  if (price <= 300) return 1;
  if (price <= 1000) return 5;
  return 10;
}

// -----------------------------
// UNIVERSAL TEXT PARSER (embedded)
// -----------------------------
function parseChartText(raw) {
  let text = (raw || "")
    .replace(/\s+/g, " ")
    .replace(/–|—/g, "-")
    .replace(/[^0-9a-zA-Z\.\:\-\/ %\$\+▲▼ ]/g, "")
    .replace(/(\d)\s+(\d)/g, "$1$2")
    .trim();

  const out = {};

  // Ticker detection (best-effort)
  const tickerMatch = text.match(/\b([A-Z]{1,6})\b/);
  if (tickerMatch) out.ticker = tickerMatch[1];

  // PRICE DETECTION
  const tickerPrice = text.match(/[A-Z]{1,6}[^0-9]*([0-9]+\.[0-9]+)/);
  const priceSymbol = text.match(/([0-9]+\.[0-9]+)\s*[+\-▲▼%]/);
  const firstDecimal = text.match(/([0-9]+\.[0-9]+)/);

  const priceMatch = tickerPrice || priceSymbol || firstDecimal;
  if (priceMatch) out.price = parseFloat(priceMatch[1]);

  // HIGH / LOW DETECTION
  const hlMatch =
    text.match(/H\/L[^0-9]*([0-9]+\.[0-9]+)[^0-9]+([0-9]+\.[0-9]+)/i) ||
    text.match(/High[^0-9]*([0-9]+\.[0-9]+)[^0-9]+Low[^0-9]*([0-9]+\.[0-9]+)/i) ||
    text.match(/([0-9]+\.[0-9]+)\s*-\s*([0-9]+\.[0-9]+)/);

  if (hlMatch) {
    out.dayHigh = parseFloat(hlMatch[1]);
    out.dayLow  = parseFloat(hlMatch[2]);
  }

  // MOVING AVERAGES
  const ma20  = text.match(/MA ?20[: ]*([0-9]+\.[0-9]+)/i);
  const ma50  = text.match(/MA ?50[: ]*([0-9]+\.[0-9]+)/i);
  const ma200 = text.match(/MA ?200[: ]*([0-9]+\.[0-9]+)/i);

  if (ma20)  out.maFast = parseFloat(ma20[1]);
  if (ma50)  out.maSlow = parseFloat(ma50[1]);
  if (ma200) out.ma200  = parseFloat(ma200[1]);

  // IV or % hints
  const ivMatch = text.match(/IV[: ]*([0-9]{1,3}\.?[0-9]?)%/i);
  if (ivMatch) out.iv = ivMatch[1] + '%';

  return out;
}

// -----------------------------
// PATTERN / STRUCTURE DETECTORS (embedded)
// -----------------------------
function detectBullFlag(data) {
  const { price, dayHigh, dayLow, maFast, maSlow, ma200 } = data || {};
  if ([price, dayHigh, dayLow, maFast, maSlow].some(v => v == null || isNaN(v))) {
    return { isFlag: false, notes: [] };
  }
  const notes = [];
  const range = dayHigh - dayLow;
  if (range <= 0) return { isFlag: false, notes };
  const pos = (price - dayLow) / range;
  if (pos < 0.6) return { isFlag: false, notes };
  notes.push("Price is holding in the upper part of today’s range.");
  if (!(price > maFast && price > maSlow)) return { isFlag: false, notes };
  notes.push("Price is above both fast and slow moving averages.");
  const diffFS = Math.abs(maFast - maSlow);
  if (diffFS > price * 0.01) return { isFlag: false, notes };
  notes.push("Fast and slow MAs are tight → consolidation.");
  if (!isNaN(ma200)) {
    const maxMA = Math.max(maFast, maSlow, ma200);
    const minMA = Math.min(maFast, maSlow, ma200);
    if ((maxMA - minMA) > price * 0.02) return { isFlag: false, notes };
    notes.push("20 / 50 / 200 MAs are clustered → strong trend.");
  }
  notes.push("Bullish flag golden play detected.");
  return { isFlag: true, notes };
}

function detectEvenProximity(price) {
  if (!price && price !== 0) return null;
  const step = dynamicStep(price);
  const nearest = Math.round(price / step) * step;
  const diff = price - nearest;
  return {
    nearest,
    diff,
    step,
    isNear: Math.abs(diff) <= step * 0.2,
    isJustAbove: diff > 0 && Math.abs(diff) <= step * 0.2,
    isJustBelow: diff < 0 && Math.abs(diff) <= step * 0.2
  };
}

function detectMACluster({ maFast, maSlow, ma200, price } = {}) {
  const arr = [maFast, maSlow, ma200].filter(v => v != null && !isNaN(v));
  if (arr.length < 2 || !price) return { clustered: false, spread: null, max: null, min: null };
  const max = Math.max(...arr);
  const min = Math.min(...arr);
  const spread = max - min;
  return {
    clustered: spread <= price * 0.015,
    spread,
    max,
    min
  };
}

function detectMASlope(history) {
  if (!history || history.length < 3) return null;
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  const slopeFast = (last.maFast ?? 0) - (prev.maFast ?? 0);
  const slopeSlow = (last.maSlow ?? 0) - (prev.maSlow ?? 0);
  const slopePrice = (last.price ?? 0) - (prev.price ?? 0);
  return {
    slopeFast,
    slopeSlow,
    slopePrice,
    fastUp: slopeFast > 0,
    fastDown: slopeFast < 0,
    slowUp: slopeSlow > 0,
    slowDown: slopeSlow < 0,
    priceUp: slopePrice > 0,
    priceDown: slopePrice < 0,
    sharpMove: Math.abs(slopePrice) > (last.price ?? 0) * 0.01
  };
}

function detectSupportResistance(history, toleranceFactor = 0.2) {
  if (!history || history.length === 0) return { supports: [], resistances: [] };
  const prices = history.map(c => c.price).filter(p => p != null);
  if (prices.length === 0) return { supports: [], resistances: [] };
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const tolerance = avgPrice * (toleranceFactor / 100) || 0.2;
  const levels = {};
  prices.forEach(p => {
    const key = Math.round(p / tolerance) * tolerance;
    if (!levels[key]) levels[key] = { level: key, hits: 0 };
    levels[key].hits++;
  });
  const arr = Object.values(levels);
  const strong = arr.filter(l => l.hits >= 3);
  return { supports: strong, resistances: strong };
}

function detectDoubleTopBottom(history, toleranceFactor = 0.3) {
  if (!history || history.length < 5) {
    return { doubleTop: false, doubleBottom: false, max: null, min: null };
  }
  const prices = history.map(c => c.price).filter(p => p != null);
  if (prices.length < 5) {
    return { doubleTop: false, doubleBottom: false, max: null, min: null };
  }
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const tolerance = avgPrice * (toleranceFactor / 100) || 0.3;
  const topHits = prices.filter(h => Math.abs(h - max) <= tolerance).length;
  const bottomHits = prices.filter(h => Math.abs(h - min) <= tolerance).length;
  return { doubleTop: topHits >= 2, doubleBottom: bottomHits >= 2, max, min };
}

function detectRounding(history) {
  if (!history || history.length < 10) {
    return { roundingBottom: false, roundingTop: false };
  }
  const prices = history.map(c => c.price).filter(p => p != null);
  if (prices.length < 10) return { roundingBottom: false, roundingTop: false };
  const mid = Math.floor(prices.length / 2);
  const left = prices[0];
  const center = prices[mid];
  const right = prices[prices.length - 1];
  return { roundingBottom: center < left && center < right, roundingTop: center > left && center > right };
}

// -----------------------------
// RULE SYSTEM (simple plugin architecture)
// -----------------------------
const rules = [];

// Example rule: bullish flag entry
addRule({
  name: 'bull-flag-entry',
  check(data, notes, context) {
    const flag = detectBullFlag(data);
    if (!flag.isFlag) return null;
    notes.push(...flag.notes);
    // Plan: entry = price - small step, stop = dayLow - step, target = price + range
    const entry = Number((data.price - dynamicStep(data.price) * 0.5).toFixed(2));
    const stop = Number((data.dayLow - dynamicStep(data.price)).toFixed(2));
    const target = Number((data.price + (data.dayHigh - data.dayLow)).toFixed(2));
    return { direction: 'call', entry, stop, target, wait: Math.abs(data.price - entry) > dynamicStep(data.price) * 1.5 ? true : false };
  }
});

// Example rule: breakdown short
addRule({
  name: 'breakdown-short',
  check(data, notes, context) {
    if (!data.price || !data.dayLow || !data.dayHigh) return null;
    if (data.price < data.dayLow + (data.dayHigh - data.dayLow) * 0.05) {
      notes.push('Price is pressing the low of the day → breakdown risk.');
      const entry = Number((data.price + dynamicStep(data.price) * 0.5).toFixed(2));
      const stop = Number((data.price + dynamicStep(data.price) * 2).toFixed(2));
      const target = Number((data.dayLow - (data.dayHigh - data.dayLow)).toFixed(2));
      return { direction: 'put', entry, stop, target, wait: false };
    }
    return null;
  }
});

function addRule(rule) { rules.push(rule); }
function listRules() { return rules.map(r => r.name); }

// -----------------------------
// DECISION ENGINE
// -----------------------------
function decideTrade(data, context = {}) {
  const notes = [];
  for (const rule of rules) {
    notes.push(`Checking rule: ${rule.name}`);
    try {
      const res = rule.check(data, notes, context);
      if (res) {
        notes.push(`Rule fired: ${rule.name}`);
        return { ...res, valid: true, notes };
      }
    } catch (e) {
      notes.push(`Rule error: ${rule.name} → ${String(e)}`);
    }
  }
  notes.push("No rule fired → no simple trade.");
  return { direction: "none", valid: false, entry: "", stop: "", target: "", wait: true, notes };
}

// -----------------------------
// FUTURE SIMULATION (biased walk)
// -----------------------------
function simulateFuture(data, decision, steps = 30) {
  const price = data?.price || 0;
  const candles = [];
  if (!decision?.valid) {
    for (let i = 0; i < steps; i++) {
      candles.push(price + (Math.random() - 0.5) * (price * 0.002));
    }
    return candles;
  }
  let current = price;
  const bias = decision.direction === "call" ? 1 : -1;
  for (let i = 0; i < steps; i++) {
    current += bias * price * 0.003 + (Math.random() - 0.5) * (price * 0.001);
    candles.push(current);
  }
  return candles;
}

// -----------------------------
// ADVANCED GOLDEN RENDERER (procedural, no external assets)
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
  const h = hex.replace("#", "");
  const bigint = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
  return { r: (bigint >> 16) & 255, g: (bigint >> 8) & 255, b: bigint & 255 };
}

function applyVignette(ctx, w, h, strength = 0.45) {
  const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.8);
  grad.addColorStop(0, `rgba(0,0,0,0)`);
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

function drawPriceLine(ctx, canvasW, canvasH, priceToY, price, color, accent, label) {
  if (price == null) return;
  let y;
  try { y = priceToY(price); } catch (e) { y = canvasH / 2; }
  y = clamp(y, 0, canvasH);
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.setLineDash([8, 6]);
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvasW, y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y - 3); ctx.lineTo(canvasW, y - 3); ctx.stroke();
  ctx.font = '12px system-ui, Arial'; ctx.textBaseline = 'middle';
  const text = `${label} ${price.toFixed(2)}`; const metrics = ctx.measureText(text);
  const pad = 8; const boxW = metrics.width + pad * 2; const boxH = 20;
  const boxX = canvasW - boxW - 12; const boxY = clamp(y - boxH / 2, 6, canvasH - boxH - 6);
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = color; ctx.fillText(text, boxX + pad, boxY + boxH / 2 + 1);
  applyGlow(ctx, y, canvasW, accent, 18);
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

// -----------------------------
// OCR PIPELINE (Tesseract wrapper with retries)
// -----------------------------
async function ocrCanvasWithRetriesInternal(canvas, retries = OCR_RETRIES, delay = OCR_RETRY_DELAY) {
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
// PRICE→Y INFERENCE (axis extraction)
// -----------------------------
function normalizeWords(words) {
  return words.map(w => {
    if (w.bbox) return { text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, conf: w.confidence || 0 };
    if (w.x !== undefined) return { text: w.text, x0: w.x, y0: w.y, x1: w.x + (w.w || 0), y1: w.y + (w.h || 0), conf: w.confidence || 0 };
    return null;
  }).filter(Boolean);
}

function extractAxisNumbers(words, canvasW) {
  const leftZone = canvasW * 0.18;
  const rightZone = canvasW * 0.82;
  const numRe = /[-+]?\$?\d{1,3}(?:[,\d]{0,})?(?:\.\d+)?%?/;
  const left = [], right = [];
  for (const w of words) {
    const t = (w.text || '').replace(/\s+/g, '');
    if (!t) continue;
    const m = t.match(numRe);
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

function buildPriceToYFromAxis(axisNums, canvasH) {
  if (!axisNums || axisNums.length < 2) return null;
  const n = axisNums.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const p of axisNums) {
    const x = p.val;
    const y = p.y;
    sumX += x; sumY += y; sumXY += x * y; sumXX += x * x;
  }
  const denom = (n * sumXX - sumX * sumX);
  if (Math.abs(denom) < 1e-9) return null;
  const a = (n * sumXY - sumX * sumY) / denom;
  const b = (sumY - a * sumX) / n;
  return (price) => a * price + b;
}

// -----------------------------
// RENDERER ENTRYPOINT (process image file and paint golden chart)
// -----------------------------
async function renderGoldenChartFromFileInternal(canvas, file) {
  if (!canvas || !(canvas instanceof HTMLCanvasElement)) throw new Error('Canvas required');
  if (!file) throw new Error('File required');

  // 1) load image
  const img = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => { URL.revokeObjectURL(url); resolve(i); };
    i.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    i.src = url;
  });

  // 2) preprocess for OCR
  const preCanvas = (function preprocess() {
    const ratio = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
    const w = Math.round(img.width * ratio);
    const h = Math.round(img.height * ratio);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
    const id = ctx.getImageData(0, 0, w, h); const d = id.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      sum += lum;
    }
    const mean = sum / (d.length / 4); const contrast = 1.12;
    for (let i = 0; i < d.length; i += 4) {
      let lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      lum = (lum - mean) * contrast + mean; lum = clamp(Math.round(lum), 0, 255);
      d[i] = d[i + 1] = d[i + 2] = lum;
    }
    ctx.putImageData(id, 0, 0);
    return c;
  })();

  // 3) OCR
  const ocr = await ocrCanvasWithRetriesInternal(preCanvas, OCR_RETRIES, OCR_RETRY_DELAY);

  // 4) parse text
  const parsed = parseChartText(ocr.text || '');

  // 5) axis extraction and price->y mapping
  const normWords = normalizeWords(ocr.words || []);
  const canvasW = preCanvas.width;
  const axis = extractAxisNumbers(normWords, canvasW);
  const axisNums = (axis.right.length >= axis.left.length) ? axis.right : axis.left;

  // map axis y from preCanvas to final canvas CSS size
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const scaleY = cssH / preCanvas.height;
  const axisNormalized = axisNums.map(n => ({ val: n.val, y: n.y * scaleY }));

  let priceToY = null;
  if (axisNormalized.length >= 2) {
    priceToY = buildPriceToYFromAxis(axisNormalized, cssH);
  }

  // 6) run rule engine
  const decision = decideTrade(parsed, { history: [], context: { ocrAvgConf: ocr.avgConf } });

  // 7) fallback mapping
  if (!priceToY) {
    priceToY = fallbackPriceToY(parsed, cssH);
  }
  if (!priceToY) {
    const anchor = safeNum(parsed.price, 100);
    const centerY = cssH / 2;
    const pxPerUnit = Math.max(0.5, Math.abs(anchor) * 0.01);
    priceToY = (p) => centerY - (p - anchor) * pxPerUnit;
  }

  // 8) paint stylized gold chart
  const ctx = canvas.getContext('2d', { alpha: false });
  canvas.width = Math.round(cssW * DPI); canvas.height = Math.round(cssH * DPI);
  ctx.setTransform(DPI, 0, 0, DPI, 0, 0);
  ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, cssW, cssH);

  // faint original for texture
  const fit = fitImageToCanvas(img.width, img.height, cssW, cssH);
  ctx.globalAlpha = 0.06; ctx.drawImage(img, fit.x, fit.y, fit.w, fit.h); ctx.globalAlpha = 1;

  // gold overlay gradient
  const gold = hexToRgb('#d4af37'), accent = hexToRgb('#ffd86b');
  const g = ctx.createLinearGradient(0, 0, cssW, cssH);
  g.addColorStop(0, `rgba(${gold.r},${gold.g},${gold.b},0.06)`);
  g.addColorStop(0.5, `rgba(${accent.r},${accent.g},${accent.b},0.08)`);
  g.addColorStop(1, `rgba(${gold.r},${gold.g},${gold.b},0.05)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, cssW, cssH);

  // procedural candle strip for texture
  const stripH = Math.round(cssH * 0.28);
  const stripY = Math.round(cssH * 0.36);
  const candleW = Math.max(6, Math.round(cssW / 60));
  for (let cx = 12; cx < cssW - 12; cx += candleW + 6) {
    const ch = Math.round(stripH * (0.6 + Math.random() * 0.8));
    const cy = stripY + Math.round((stripH - ch) * Math.random());
    const fillColor = `rgba(${Math.round(mix(gold.r, accent.r, Math.random() * 0.6))},${Math.round(mix(gold.g, accent.g, Math.random() * 0.6))},${Math.round(mix(gold.b, accent.b, Math.random() * 0.6))},${0.18 + Math.random() * 0.12})`;
    const edgeColor = `rgba(${Math.round(mix(gold.r, 0, 0.2))},${Math.round(mix(gold.g, 0, 0.2))},${Math.round(mix(gold.b, 0, 0.2))},0.6)`;
    const gloss = `rgba(${accent.r},${accent.g},${accent.b},0.12)`;
    paintCandleTexture(ctx, cx, cy, candleW, ch, fillColor, edgeColor, gloss);
  }

  applyVignette(ctx, cssW, cssH, 0.45);

  // draw future simulation
  const future = simulateFuture(parsed, decision, 40);
  ctx.strokeStyle = decision.direction === "call" ? "#3cff9d" : decision.direction === "put" ? "#ff4b4b" : "#999";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  future.forEach((p, i) => {
    const x = Math.round((i / (future.length - 1 || 1)) * (cssW - 40)) + 20;
    const y = priceToY(p);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // draw entry/stop/target
  drawPriceLine(ctx, cssW, cssH, priceToY, decision.entry, '#3cff9d', '#d4af37', 'ENTRY');
  drawPriceLine(ctx, cssW, cssH, priceToY, decision.stop, '#ff4b4b', '#ff8a8a', 'STOP');
  drawPriceLine(ctx, cssW, cssH, priceToY, decision.target, '#4bb8ff', '#9fdcff', 'TARGET');

  // header
  ctx.fillStyle = '#d4af37'; ctx.font = '13px system-ui, Arial'; ctx.fillText(`Golden Chart • ${nowISO()}`, 12, 18);

  // save parsed and decision to localStorage
  try {
    localStorage.setItem('gf_data', JSON.stringify(parsed));
    localStorage.setItem('gf_decision', JSON.stringify(decision));
    localStorage.setItem('gf_last_ocr_confidence', String(ocr.avgConf || 0));
    localStorage.setItem('gf_last_analysis_time', nowISO());
  } catch (e) {}

  return { ok: true, parsed, decision, ocr: { avgConf: ocr.avgConf || 0 } };
}

// small helper used above
function mix(a, b, t) { return Math.round(a * (1 - t) + b * t); }

// -----------------------------
// FINNHUB LOOKUP (optional helper functions)
// -----------------------------
async function finnhubFetch(path, params = {}) {
  const url = new URL(`https://finnhub.io/api/v1/${path}`);
  url.searchParams.set('token', FINNHUB_API_KEY);
  Object.entries(params).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Finnhub ${res.status}: ${await res.text()}`);
  return res.json();
}

async function lookupTickerAndRender(symbol, canvas) {
  const profile = await finnhubFetch('stock/profile2', { symbol });
  const quote = await finnhubFetch('quote', { symbol });
  const now = Math.floor(Date.now() / 1000);
  const from = now - 60 * 60 * 24 * 60;
  const candles = await finnhubFetch('stock/candle', { symbol, resolution: 'D', from, to: now });
  // draw simple candlestick chart into a temporary canvas and return a File-like blob
  const tmp = document.createElement('canvas');
  tmp.width = canvas.clientWidth; tmp.height = canvas.clientHeight;
  drawCandlesOnCanvas(tmp, candles, { symbol, name: profile.name, price: quote.c });
  const blob = await new Promise(res => tmp.toBlob(res, 'image/png'));
  return { blob, profile, quote, candles };
}

function drawCandlesOnCanvas(canvas, candles, meta = {}) {
  const ctx = canvas.getContext('2d');
  const cssW = canvas.width;
  const cssH = canvas.height;
  ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, cssW, cssH);
  if (!candles || candles.s !== 'ok' || !candles.c || candles.c.length === 0) {
    ctx.fillStyle = '#cfcfcf'; ctx.font = '14px system-ui, Arial'; ctx.fillText('No candle data available', 12, 24);
    return;
  }
  const o = candles.o, h = candles.h, l = candles.l, c = candles.c;
  const len = c.length;
  const pad = 36; const chartW = cssW - pad * 2; const chartH = cssH - pad * 2;
  const maxP = Math.max(...h); const minP = Math.min(...l);
  function yFor(price) { if (maxP === minP) return pad + chartH / 2; return pad + ((maxP - price) / (maxP - minP)) * chartH; }
  ctx.strokeStyle = 'rgba(212,175,55,0.06)'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = pad + (i / 4) * chartH; ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(pad + chartW, y); ctx.stroke(); }
  const candleW = Math.max(2, Math.floor(chartW / len * 0.7));
  for (let i = 0; i < len; i++) {
    const x = pad + (i / len) * chartW + (chartW / len - candleW) / 2;
    const open = o[i], high = h[i], low = l[i], close = c[i];
    const yOpen = yFor(open), yClose = yFor(close), yHigh = yFor(high), yLow = yFor(low);
    const bodyTop = Math.min(yOpen, yClose), bodyBottom = Math.max(yOpen, yClose);
    const isBull = close >= open;
    ctx.strokeStyle = isBull ? '#3cff9d' : '#ff4b4b'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + candleW / 2, yHigh); ctx.lineTo(x + candleW / 2, yLow); ctx.stroke();
    ctx.fillStyle = isBull ? 'rgba(60,255,157,0.18)' : 'rgba(255,75,75,0.18)';
    ctx.fillRect(x, bodyTop, candleW, Math.max(1, bodyBottom - bodyTop));
    ctx.strokeStyle = isBull ? '#3cff9d' : '#ff4b4b'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, bodyTop + 0.5, candleW - 1, Math.max(1, bodyBottom - bodyTop) - 1);
  }
  ctx.fillStyle = '#d4af37'; ctx.font = '12px system-ui, Arial';
  ctx.fillText(`High ${maxP.toFixed(2)}`, pad + 6, pad + 12);
  ctx.fillText(`Low ${minP.toFixed(2)}`, pad + 6, pad + chartH - 6);
  const metaText = `${meta.symbol || ''} ${meta.name ? '• ' + meta.name : ''}  |  Price: ${meta.price != null ? meta.price.toFixed(2) : 'n/a'}`;
  ctx.fillStyle = '#cfcfcf'; ctx.font = '12px system-ui, Arial'; ctx.fillText(metaText, pad, cssH - 8);
}

// -----------------------------
// MAIN PROCESSING FLOW (file -> analysis -> render -> save)
// -----------------------------
async function processFile(file) {
  const statusEl = document.getElementById(STATUS_ID);
  const outEl = document.getElementById(OUTPUT_ID);
  const logEl = document.getElementById(LOG_ID);
  const canvas = document.getElementById(CANVAS_ID);

  try {
    statusEl.textContent = 'Loading image...';
    const res = await renderGoldenChartFromFileInternal(canvas, file);
    outEl.innerHTML = buildSummaryHtml(res.parsed, res.decision, res.ocr);
    logEl.innerText = JSON.stringify({ parsed: res.parsed, decision: res.decision, ocr: res.ocr }, null, 2);
    statusEl.textContent = 'Analysis complete';
    return res;
  } catch (err) {
    console.error('Processing error', err);
    statusEl.textContent = 'Could not process image';
    outEl.innerHTML = `<p style="color:#ff8a8a">Error: ${err?.message || 'Unknown error'}</p>`;
    logEl.innerText = String(err?.stack || err);
    return { ok: false, error: err };
  }
}

function buildSummaryHtml(parsed, decision, ocr) {
  const conf = ocr && ocr.avgConf ? `${ocr.avgConf.toFixed(1)}%` : 'n/a';
  let html = `<div class="sim-summary"><p><strong>OCR confidence:</strong> ${conf}</p>`;
  if (decision && decision.valid) {
    html += `<p><strong>Decision:</strong> ${decision.direction.toUpperCase()}</p>`;
    html += `<p><strong>Entry:</strong> ${decision.entry} &nbsp; <strong>Stop:</strong> ${decision.stop} &nbsp; <strong>Target:</strong> ${decision.target}</p>`;
  } else {
    html += `<p><strong>No clean setup detected</strong></p>`;
  }
  if (parsed && (parsed.price || parsed.dayHigh || parsed.dayLow)) {
    html += `<p><strong>Parsed:</strong> price ${parsed.price ?? 'n/a'}; high ${parsed.dayHigh ?? 'n/a'}; low ${parsed.dayLow ?? 'n/a'}</p>`;
  }
  html += `</div>`;
  return html;
}

// -----------------------------
// UI WIRING: file input, drag/drop, paste, canvas click
// -----------------------------
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById(FILE_INPUT_ID);
  const canvas = document.getElementById(CANVAS_ID);
  const statusEl = document.getElementById(STATUS_ID);

  if (!fileInput) {
    console.warn('File input not found');
    return;
  }

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    statusEl.textContent = 'File selected. Starting analysis...';
    await processFile(file);
  });

  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    statusEl.textContent = 'File dropped. Starting analysis...';
    await processFile(file);
  });

  document.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (items) {
      for (const it of items) {
        if (it.type && it.type.indexOf('image') !== -1) {
          const blob = it.getAsFile();
          if (blob) {
            statusEl.textContent = 'Pasted image detected — processing...';
            await processFile(blob);
            return;
          }
        }
      }
    }
    const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (text && /^[A-Za-z]{1,6}$/.test(text.trim())) {
      // If user pasted a ticker, attempt Finnhub lookup and render then send to simulator
      const symbol = text.trim().toUpperCase();
      try {
        statusEl.textContent = `Pasted ticker ${symbol} — fetching chart...`;
        const lookupCanvas = document.createElement('canvas');
        lookupCanvas.width = 900; lookupCanvas.height = 420;
        const { blob } = await lookupTickerAndRender(symbol, lookupCanvas);
        statusEl.textContent = 'Lookup chart generated — analyzing...';
        await processFile(new File([blob], `${symbol}.png`, { type: 'image/png' }));
      } catch (err) {
        console.warn('Ticker paste lookup failed', err);
        statusEl.textContent = 'Ticker lookup failed';
      }
    }
  });

  if (canvas) canvas.addEventListener('click', () => fileInput.click());

  statusEl.textContent = 'Ready. Drop a chart, paste an image, or click to upload.';
});

// -----------------------------
// Expose small debug API
// -----------------------------
window.__GF_SIM = {
  processFile,
  renderGoldenChartFromFileInternal,
  lookupTickerAndRender,
  listRules
};
