// modules/goldenChartAuto.js
// Golden Chart Auto Renderer
// - Single entry: renderGoldenChartFromFile(canvas, file)
// - Requires core.js exports: parseChartText, decideTrade
// - Requires Tesseract available on window.Tesseract
//
// Usage example:
// import { renderGoldenChartFromFile } from './modules/goldenChartAuto.js';
// await renderGoldenChartFromFile(document.getElementById('sim-canvas'), droppedFile);

const Tesseract = window.Tesseract;

import { parseChartText, decideTrade } from './core.js';

const DEFAULT_MAX_DIM = 1600;
const DPI = window.devicePixelRatio || 1;

// Utility helpers
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function nowISO() { return new Date().toISOString(); }
function safeNum(v, fallback = null) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Load image from File
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

// Resize and preprocess to canvas (grayscale + mild contrast)
function preprocessImageToCanvas(img, maxDim = DEFAULT_MAX_DIM) {
  const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  ctx.drawImage(img, 0, 0, w, h);

  // grayscale + contrast stretch
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  // compute mean luminance
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
    sum += lum;
  }
  const mean = sum / (d.length / 4);
  const contrast = 1.12;
  for (let i = 0; i < d.length; i += 4) {
    let lum = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
    lum = (lum - mean) * contrast + mean;
    lum = clamp(Math.round(lum), 0, 255);
    d[i] = d[i+1] = d[i+2] = lum;
  }
  ctx.putImageData(id, 0, 0);
  return canvas;
}

// Run Tesseract on canvas and return result with words and bounding boxes
async function ocrCanvas(canvas, lang = 'eng') {
  // convert to blob
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  const res = await Tesseract.recognize(blob, lang, {
    // numeric-friendly config
    tessedit_char_whitelist: '0123456789.,%$-–—ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',
    preserve_interword_spaces: '1'
  });
  return res; // res.data.words contains words with bbox and text and confidence
}

// Find numeric labels near left and right edges using OCR word boxes
function extractAxisNumbersFromWords(words, canvasW, canvasH) {
  // words: array of { text, bbox: { x0,y0,x1,y1 } or x, y, w, h depending on Tesseract version }
  // We'll normalize to {x0,y0,x1,y1, text}
  const normalized = words.map(w => {
    if (w.bbox) {
      return { text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 };
    } else if (w.x !== undefined && w.y !== undefined && w.w !== undefined && w.h !== undefined) {
      return { text: w.text, x0: w.x, y0: w.y, x1: w.x + w.w, y1: w.y + w.h };
    } else {
      return null;
    }
  }).filter(Boolean);

  // Candidate numeric regex (allow commas, decimals, optional $ or %)
  const numRe = /[-+]?\$?\d{1,3}(?:[,\d]{0,})?(?:\.\d+)?%?/;

  // Define edge zones (20% width from left/right)
  const leftZone = canvasW * 0.18;
  const rightZone = canvasW * 0.82;

  const leftNums = [];
  const rightNums = [];

  for (const w of normalized) {
    const t = w.text.replace(/\s+/g, '');
    if (!t) continue;
    const m = t.match(numRe);
    if (!m) continue;
    const numText = m[0].replace(/[$,%]/g, '').replace(/,/g, '');
    const val = Number(numText);
    if (!Number.isFinite(val)) continue;

    const cx = (w.x0 + w.x1) / 2;
    const cy = (w.y0 + w.y1) / 2;

    if (cx <= leftZone) leftNums.push({ val, x: cx, y: cy, raw: w.text });
    else if (cx >= rightZone) rightNums.push({ val, x: cx, y: cy, raw: w.text });
  }

  // Sort by y (top to bottom)
  leftNums.sort((a,b) => a.y - b.y);
  rightNums.sort((a,b) => a.y - b.y);

  return { leftNums, rightNums };
}

// Build linear mapping price -> y using axis numbers
function buildPriceToYFromAxis(axisNums, canvasH) {
  // axisNums: array of { val, y } sorted top->bottom
  if (!axisNums || axisNums.length < 2) return null;
  // Use linear regression (val vs y) to map price -> y
  const n = axisNums.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const p of axisNums) {
    const x = p.val;
    const y = p.y;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = (n * sumXX - sumX * sumX);
  if (Math.abs(denom) < 1e-6) return null;
  const a = (n * sumXY - sumX * sumY) / denom; // slope (y per price)
  const b = (sumY - a * sumX) / n; // intercept
  // priceToY: y = a * price + b
  return function(price) { return a * price + b; };
}

// Fallback mapping using dayHigh/dayLow or price +/- percent
function buildFallbackPriceToY(parsed, canvasH) {
  // parsed may contain price, dayHigh, dayLow
  const price = safeNum(parsed.price, null);
  const high = safeNum(parsed.dayHigh, null);
  const low = safeNum(parsed.dayLow, null);

  if (high != null && low != null && high !== low) {
    // map top of canvas to high, bottom to low
    const topY = canvasH * 0.08;
    const bottomY = canvasH * 0.92;
    return function(p) {
      const t = (high - p) / (high - low); // 0 -> high, 1 -> low
      return topY + t * (bottomY - topY);
    };
  }

  // If only price known, map price to center and use a small scale
  if (price != null) {
    const centerY = canvasH / 2;
    const pxPerUnit = Math.max(1, Math.abs(price) * 0.01);
    return function(p) {
      return centerY - (p - price) * pxPerUnit;
    };
  }

  // No info
  return null;
}

// Stylize and draw the original image in gold/black and overlay lines
function paintGoldImageAndOverlay(canvas, img, priceToY, decision, ocrMeta = {}) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  // high DPI
  canvas.width = Math.round(cssW * DPI);
  canvas.height = Math.round(cssH * DPI);
  ctx.setTransform(DPI, 0, 0, DPI, 0, 0);

  // Fit image into canvas
  const fit = fitImageToCanvas(img.width, img.height, cssW, cssH);
  // draw original faintly for texture
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.globalAlpha = 0.06;
  ctx.drawImage(img, fit.x, fit.y, fit.w, fit.h);
  ctx.globalAlpha = 1;

  // draw stylized gold layer by drawing image to offscreen, grayscale, then colorize
  const off = document.createElement('canvas');
  off.width = fit.w;
  off.height = fit.h;
  const offCtx = off.getContext('2d');
  offCtx.drawImage(img, fit.x, fit.y, fit.w, fit.h, 0, 0, fit.w, fit.h);
  // grayscale
  const id = offCtx.getImageData(0, 0, fit.w, fit.h);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
    d[i] = d[i+1] = d[i+2] = lum;
  }
  offCtx.putImageData(id, 0, 0);

  // colorize to gold gradient
  const gold = hexToRgb('#d4af37');
  const accent = hexToRgb('#ffd86b');
  const out = offCtx.getImageData(0, 0, fit.w, fit.h);
  const od = out.data;
  for (let i = 0; i < od.length; i += 4) {
    const lum = id.data[i]; // grayscale
    const t = lum / 255;
    const r = Math.round(gold.r * (1 - t) + accent.r * t);
    const g = Math.round(gold.g * (1 - t) + accent.g * t);
    const b = Math.round(gold.b * (1 - t) + accent.b * t);
    od[i] = r; od[i+1] = g; od[i+2] = b; od[i+3] = 255;
  }
  offCtx.putImageData(out, 0, 0);

  // draw gold image centered
  ctx.drawImage(off, fit.x, fit.y, fit.w, fit.h);

  // vignette
  applyVignette(ctx, cssW, cssH, 0.45);

  // draw entry/stop/target lines using priceToY
  const entry = safeNum(decision.entry, null);
  const stop = safeNum(decision.stop, null);
  const target = safeNum(decision.target, null);

  // helper to draw labeled line
  function drawLine(price, color, label) {
    if (price == null || !priceToY) return;
    let y;
    try { y = priceToY(price); } catch (e) { y = cssH / 2; }
    y = clamp(y, 0, cssH);
    // dashed line
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8,6]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cssW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    // accent
    ctx.strokeStyle = lighten(color, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y - 3);
    ctx.lineTo(cssW, y - 3);
    ctx.stroke();
    // label box
    const fontSize = 12;
    ctx.font = `${fontSize}px system-ui, Arial`;
    ctx.textBaseline = 'middle';
    const text = `${label} ${price.toFixed(2)}`;
    const metrics = ctx.measureText(text);
    const pad = 8;
    const boxW = metrics.width + pad * 2;
    const boxH = fontSize + 8;
    const boxX = cssW - boxW - 12;
    const boxY = clamp(y - boxH / 2, 6, cssH - boxH - 6);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(boxX, boxY, boxW, boxH);
    ctx.fillStyle = color;
    ctx.fillText(text, boxX + pad, boxY + boxH / 2 + 1);
    ctx.restore();
    // glow
    applyGlow(ctx, y, cssW, color, 18);
  }

  drawLine(entry, '#3cff9d', 'ENTRY');
  drawLine(stop, '#ff4b4b', 'STOP');
  drawLine(target, '#4bb8ff', 'TARGET');

  // small header
  ctx.fillStyle = '#d4af37';
  ctx.font = '13px system-ui, Arial';
  ctx.fillText(`Golden Chart • ${nowISO()}`, 12, 18);

  // return metadata
  return { width: cssW, height: cssH };
}

// Fit image to canvas preserving aspect ratio and center
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

// Visual helpers
function hexToRgb(hex) {
  const h = hex.replace('#','');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function lighten(hex, amount = 0.2) {
  const c = hexToRgb(hex);
  const r = clamp(Math.round(c.r + (255 - c.r) * amount), 0, 255);
  const g = clamp(Math.round(c.g + (255 - c.g) * amount), 0, 255);
  const b = clamp(Math.round(c.b + (255 - c.b) * amount), 0, 255);
  return `rgb(${r},${g},${b})`;
}
function applyVignette(ctx, w, h, strength = 0.5) {
  const grad = ctx.createRadialGradient(w/2, h/2, Math.min(w,h)*0.2, w/2, h/2, Math.max(w,h)*0.8);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, `rgba(0,0,0,${clamp(strength,0,1)})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0,0,w,h);
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

// Main exported function
export async function renderGoldenChartFromFile(canvas, file) {
  if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
    throw new Error('canvas must be an HTMLCanvasElement');
  }
  if (!file) throw new Error('file required');

  // 1) load and preprocess
  const img = await loadImageFromFile(file);
  const preCanvas = preprocessImageToCanvas(img, DEFAULT_MAX_DIM);

  // 2) OCR
  const ocrRes = await ocrCanvas(preCanvas, 'eng');
  const words = (ocrRes?.data?.words || []).map(w => {
    // normalize to {text, x0,y0,x1,y1}
    if (w.bbox) return { text: w.text, bbox: w.bbox, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 };
    // older tesseract versions
    return { text: w.text, x0: w.x0 || w.x, y0: w.y0 || w.y, x1: (w.x0 || w.x) + (w.w || 0), y1: (w.y0 || w.y) + (w.h || 0) };
  });

  // 3) attempt to extract axis numbers
  const canvasW = preCanvas.width;
  const canvasH = preCanvas.height;
  const { leftNums, rightNums } = extractAxisNumbersFromWords(words, canvasW, canvasH);

  // choose best axis side (prefer right if it has more numbers)
  const axisNums = (rightNums.length >= leftNums.length) ? rightNums : leftNums;

  // map axis y coordinates from preCanvas space to final canvas CSS size
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const scaleX = cssW / preCanvas.width;
  const scaleY = cssH / preCanvas.height;

  // normalize axis numbers to CSS coordinates
  const axisNormalized = axisNums.map(n => ({ val: n.val, y: n.y * scaleY }));

  // 4) build priceToY mapping
  let priceToY = null;
  if (axisNormalized.length >= 2) {
    priceToY = buildPriceToYFromAxis(axisNormalized, cssH);
  }

  // 5) parse chart text and run rule engine to get entry/stop/target
  const parsed = parseChartText(ocrRes?.data?.text || '');
  const decision = decideTrade(parsed, { history: [] });

  // 6) if priceToY missing, fallback to dayHigh/dayLow or price heuristics
  if (!priceToY) {
    const fallback = buildFallbackPriceToY(parsed, cssH);
    if (fallback) priceToY = fallback;
  }

  // 7) final fallback: map center and use small scale
  if (!priceToY) {
    const centerY = cssH / 2;
    const priceAnchor = safeNum(parsed.price, 100);
    const pxPerUnit = Math.max(0.5, Math.abs(priceAnchor) * 0.01);
    priceToY = (p) => centerY - (p - priceAnchor) * pxPerUnit;
  }

  // 8) paint stylized gold image and overlay predicted lines
  const meta = paintGoldImageAndOverlay(canvas, img, priceToY, decision, { ocrAvgConf: computeAvgConfidence(ocrRes) });

  // 9) save results for options page
  const dataToSave = {
    parsed,
    decision,
    ocrConfidence: computeAvgConfidence(ocrRes),
    analysisTime: nowISO()
  };
  try {
    localStorage.setItem('gf_data', JSON.stringify(parsed));
    localStorage.setItem('gf_decision', JSON.stringify(decision));
    localStorage.setItem('gf_last_analysis', JSON.stringify(dataToSave));
  } catch (e) {
    // ignore storage errors
  }

  return { ok: true, meta, parsed, decision, ocr: { avgConf: computeAvgConfidence(ocrRes) } };
}

// compute average confidence from tesseract result
function computeAvgConfidence(res) {
  const words = res?.data?.words || [];
  if (!words.length) return 0;
  const sum = words.reduce((s, w) => s + (w.confidence || 0), 0);
  return sum / words.length;
}

// Build priceToY from axisNormalized (helper used above)
function buildPriceToYFromAxis(axisNormalized, canvasH) {
  if (!axisNormalized || axisNormalized.length < 2) return null;
  // linear regression val -> y
  const n = axisNormalized.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const p of axisNormalized) {
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
