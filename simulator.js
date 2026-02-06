// modules/simulator.js
// Advanced Simulator — full, extended, mentor-grade engine
// Responsibilities:
//  - Accept dropped or selected image
//  - Preprocess image for OCR
//  - Run OCR with retries and confidence scoring
//  - Parse chart text via core.parseChartText
//  - Run rule engine via core.decideTrade
//  - Infer price-to-Y mapping from axis labels and numeric text in the image
//  - Build an extremely long, layered narrative and observations
//  - Render cinematic gold chart overlaying entry, stop, target and future simulation
//  - Save gf_data and gf_decision to localStorage for options page
//  - Provide detailed debug output in the UI
//
// Requires these modules in /modules:
//  - core.js (exports parseChartText, decideTrade, simulateFuture, detect* helpers)
//  - goldenChartAuto.js (exports renderGoldenChartFromFile or internal painting helpers)
//  - Tesseract loaded globally via script tag in HTML

const Tesseract = window.Tesseract;

import {
  parseChartText,
  decideTrade,
  simulateFuture,
  detectBullFlag,
  detectEvenProximity,
  detectMACluster,
  detectMASlope,
  detectSupportResistance,
  detectDoubleTopBottom,
  detectRounding,
  dynamicStep
} from './core.js';

// If you placed the auto renderer module, import it; otherwise we will use internal painting
import { renderGoldenChartFromFile } from './goldenChartAuto.js';

// Configuration
const FILE_INPUT_ID = 'file-input';
const STATUS_ID = 'sim-status';
const CANVAS_ID = 'sim-canvas';
const OUTPUT_ID = 'sim-output';
const LOG_ID = 'sim-log';
const MAX_DIM = 1600;
const OCR_RETRIES = 2;
const OCR_RETRY_DELAY = 600;

// Utilities
function nowISO() { return new Date().toISOString(); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function safeNum(v, fallback = null) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Image helpers
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

function preprocessImage(img, maxDim = MAX_DIM) {
  const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);

  // mild grayscale + contrast stretch
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
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

// OCR pipeline with retries and average confidence
async function ocrCanvasWithRetries(canvas, retries = OCR_RETRIES, delay = OCR_RETRY_DELAY) {
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

// Axis extraction from OCR words
function normalizeWords(words) {
  return words.map(w => {
    if (w.bbox) return { text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, conf: w.confidence || 0 };
    if (w.x !== undefined && w.y !== undefined && w.w !== undefined && w.h !== undefined) {
      return { text: w.text, x0: w.x, y0: w.y, x1: w.x + w.w, y1: w.y + w.h, conf: w.confidence || 0 };
    }
    return { text: w.text || '', x0: 0, y0: 0, x1: 0, y1: 0, conf: w.confidence || 0 };
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
  left.sort((a,b) => a.y - b.y);
  right.sort((a,b) => a.y - b.y);
  return { left, right };
}

// Build linear mapping price -> y using axis numbers (regression)
function buildPriceToY(axisNums) {
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

// Long narrative builder
function buildLongNarrative(parsed, decision, detectors, ocrMeta) {
  const parts = [];
  parts.push(`<div style="color:#dcdcdc;font-size:13px">`);
  parts.push(`<div style="color:#d4af37;font-weight:700;margin-bottom:8px">Golden Read — ${nowISO()}</div>`);

  // OCR meta
  parts.push(`<div style="color:#bdbdbd;margin-bottom:8px"><strong>OCR confidence</strong>: ${(ocrMeta.avgConf || 0).toFixed(1)}%</div>`);

  // Parsed summary
  parts.push(`<div style="margin-bottom:8px"><strong>Parsed snapshot</strong>:</div>`);
  parts.push(`<ul style="color:#cfcfcf">`);
  parts.push(`<li>Price: ${safeNum(parsed.price, 'n/a')}</li>`);
  parts.push(`<li>Day High: ${safeNum(parsed.dayHigh, 'n/a')}</li>`);
  parts.push(`<li>Day Low: ${safeNum(parsed.dayLow, 'n/a')}</li>`);
  parts.push(`<li>MA20/MA50/MA200: ${safeNum(parsed.maFast,'n/a')} / ${safeNum(parsed.maSlow,'n/a')} / ${safeNum(parsed.ma200,'n/a')}</li>`);
  if (parsed.ticker) parts.push(`<li>Ticker: ${parsed.ticker}</li>`);
  parts.push(`</ul>`);

  // Detectors
  parts.push(`<div style="margin-top:8px"><strong>Structure observations</strong>:</div>`);
  if (detectors.flag?.isFlag) {
    parts.push(`<p style="color:#9fffbf">Bull flag detected — price holding upper range, tight MAs, consolidation ready for continuation.</p>`);
  } else {
    parts.push(`<p style="color:#cfcfcf">No clear bull flag detected by the quick scan.</p>`);
  }
  if (detectors.maCluster?.clustered) {
    parts.push(`<p style="color:#cfcfcf">MAs clustered — consolidation present; breakout potential when price chooses a side.</p>`);
  }
  if (detectors.even?.isNear) {
    const side = detectors.even.isJustAbove ? 'just above' : detectors.even.isJustBelow ? 'just below' : 'near';
    parts.push(`<p style="color:#cfcfcf">Price is ${side} an even level at ${detectors.even.nearest.toFixed(2)} — expect magnet/wall behavior.</p>`);
  }

  // Decision
  parts.push(`<div style="margin-top:10px"><strong>Engine decision</strong>:</div>`);
  if (!decision.valid) {
    parts.push(`<p style="color:#ffb3b3">No clean setup. The engine recommends standing aside until structure clarifies or price retests a key level.</p>`);
    parts.push(`<ul style="color:#cfcfcf">${(decision.notes || []).map(n => `<li>${n}</li>`).join('')}</ul>`);
  } else {
    parts.push(`<p style="color:#bfffbf">Direction: <strong>${decision.direction.toUpperCase()}</strong></p>`);
    parts.push(`<p style="color:#cfcfcf">Entry: ${decision.entry} • Stop: ${decision.stop} • Target: ${decision.target}</p>`);
    parts.push(`<div style="color:#cfcfcf;margin-top:6px"><strong>Why this trade</strong>:</div>`);
    parts.push(`<ul style="color:#cfcfcf">${(decision.notes || []).map(n => `<li>${n}</li>`).join('')}</ul>`);
    // composite confidence heuristic
    const ocrConf = ocrMeta.avgConf || 0;
    let structuralScore = 50;
    if (detectors.maCluster?.clustered) structuralScore += 10;
    if (detectors.flag?.isFlag) structuralScore += 15;
    if (!decision.wait) structuralScore += 10;
    const composite = clamp(Math.round((ocrConf * 0.4) + (structuralScore * 0.6)), 0, 100);
    parts.push(`<p style="color:#cfcfcf">Composite confidence: <strong>${composite}%</strong> (OCR ${ocrConf.toFixed(1)}% + structure ${structuralScore})</p>`);
    parts.push(`<p style="color:#cfcfcf">Action guidance: ${decision.wait ? 'Wait for a better fill near entry.' : 'Scale in according to your risk plan.'}</p>`);
  }

  // Trade management
  parts.push(`<div style="margin-top:10px"><strong>Trade management</strong>:</div>`);
  parts.push(`<ol style="color:#cfcfcf">`);
  parts.push(`<li>Size to risk: calculate position so a full stop-out equals your pre-defined risk per trade.</li>`);
  parts.push(`<li>Use underlying stop level, not option price, to manage risk.</li>`);
  parts.push(`<li>If the chart no longer matches the original setup, exit the trade even if the option still has time.</li>`);
  parts.push(`</ol>`);

  // Mentor closing
  parts.push(`<div style="margin-top:12px;color:#d4af37">Mentor note</div>`);
  parts.push(`<p style="color:#cfcfcf">This read is derived entirely from the photo you provided. If you want, I will now build the 5-strike ladder and recommend the exact contract and expiration based on this read.</p>`);

  parts.push(`</div>`);
  return parts.join('');
}

// Render pipeline: uses renderGoldenChartFromFile if available, otherwise falls back to internal painting
async function renderAndAnnotate(canvas, file, parsed, decision, ocrMeta) {
  // If the auto renderer exists, use it because it already infers scale and paints
  if (typeof renderGoldenChartFromFile === 'function') {
    return await renderGoldenChartFromFile(canvas, file);
  }

  // Fallback: simple painting using parsed dayHigh/dayLow mapping
  // (This fallback is unlikely because goldenChartAuto should be present)
  const img = await loadImageFromFile(file);
  const ctx = canvas.getContext('2d');
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = Math.round(cssW * (window.devicePixelRatio || 1));
  canvas.height = Math.round(cssH * (window.devicePixelRatio || 1));
  ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, cssW, cssH);
  // draw image fit
  const fit = fitImageToCanvas(img.width, img.height, cssW, cssH);
  ctx.globalAlpha = 0.06;
  ctx.drawImage(img, fit.x, fit.y, fit.w, fit.h);
  ctx.globalAlpha = 1;
  // simple gold overlay
  ctx.fillStyle = 'rgba(212,175,55,0.06)';
  ctx.fillRect(0, 0, cssW, cssH);
  // draw entry/stop/target using fallback mapping
  const priceToY = fallbackPriceToY(parsed, cssH) || ((p) => cssH / 2);
  drawLine(ctx, cssW, cssH, priceToY, decision.entry, '#3cff9d', 'ENTRY');
  drawLine(ctx, cssW, cssH, priceToY, decision.stop, '#ff4b4b', 'STOP');
  drawLine(ctx, cssW, cssH, priceToY, decision.target, '#4bb8ff', 'TARGET');
  return { ok: true };
}

// Helper drawLine for fallback
function drawLine(ctx, w, h, priceToY, price, color, label) {
  if (price == null) return;
  let y = priceToY(price);
  y = clamp(y, 0, h);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([8,6]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(w, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = '12px system-ui, Arial';
  const text = `${label} ${price.toFixed(2)}`;
  const metrics = ctx.measureText(text);
  const boxW = metrics.width + 16;
  const boxH = 20;
  const boxX = w - boxW - 12;
  const boxY = clamp(y - boxH / 2, 6, h - boxH - 6);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = color;
  ctx.strokeRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = color;
  ctx.fillText(text, boxX + 8, boxY + boxH / 2 + 4);
  ctx.restore();
}

// Fit image helper
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

// Fallback priceToY builder
function fallbackPriceToY(parsed, canvasH) {
  const price = safeNum(parsed.price, null);
  const high = safeNum(parsed.dayHigh, null);
  const low = safeNum(parsed.dayLow, null);
  if (high != null && low != null && high !== low) {
    const topY = canvasH * 0.08;
    const bottomY = canvasH * 0.92;
    return (p) => topY + ((high - p) / (high - low)) * (bottomY - topY);
  }
  if (price != null) {
    const centerY = canvasH / 2;
    const pxPerUnit = Math.max(0.5, Math.abs(price) * 0.01);
    return (p) => centerY - (p - price) * pxPerUnit;
  }
  return null;
}

// Main handler that ties everything together
async function processFile(file) {
  const statusEl = document.getElementById(STATUS_ID);
  const outEl = document.getElementById(OUTPUT_ID);
  const logEl = document.getElementById(LOG_ID);
  const canvas = document.getElementById(CANVAS_ID);

  try {
    statusEl.textContent = 'Loading image...';
    const img = await loadImageFromFile(file);

    statusEl.textContent = 'Preprocessing image for OCR...';
    const preCanvas = preprocessImage(img, MAX_DIM);

    statusEl.textContent = 'Running OCR...';
    const ocr = await ocrCanvasWithRetries(preCanvas, OCR_RETRIES, OCR_RETRY_DELAY);

    statusEl.textContent = 'Parsing chart text...';
    const parsed = parseChartText(ocr.text || '');

    // Normalize words and extract axis numbers
    const normWords = normalizeWords(ocr.words || []);
    const canvasW = preCanvas.width;
    const axis = extractAxisNumbers(normWords, canvasW);
    const axisNums = (axis.right.length >= axis.left.length) ? axis.right : axis.left;

    // Map axis y from preCanvas to final canvas CSS size
    const cssCanvas = document.getElementById(CANVAS_ID);
    const cssW = cssCanvas.clientWidth;
    const cssH = cssCanvas.clientHeight;
    const scaleY = cssH / preCanvas.height;
    const axisNormalized = axisNums.map(n => ({ val: n.val, y: n.y * scaleY }));

    // Build priceToY mapping
    let priceToY = null;
    if (axisNormalized.length >= 2) {
      priceToY = buildPriceToY(axisNormalized);
    }

    // Run rule engine
    statusEl.textContent = 'Running rule engine...';
    const decision = decideTrade(parsed, { history: [], context: { ocrAvgConf: ocr.avgConf } });

    // If no axis mapping, fallback
    if (!priceToY) {
      priceToY = fallbackPriceToY(parsed, cssH);
    }
    // Final fallback mapping
    if (!priceToY) {
      const anchor = safeNum(parsed.price, 100);
      const centerY = cssH / 2;
      const pxPerUnit = Math.max(0.5, Math.abs(anchor) * 0.01);
      priceToY = (p) => centerY - (p - anchor) * pxPerUnit;
    }

    // Build detectors for narrative
    const detectors = {
      flag: detectBullFlag(parsed),
      even: detectEvenProximity(parsed.price),
      maCluster: detectMACluster(parsed),
      slope: detectMASlope([]),
      sr: detectSupportResistance([]),
      double: detectDoubleTopBottom([]),
      rounding: detectRounding([])
    };

    // Build long narrative
    const narrative = buildLongNarrative(parsed, decision, detectors, { avgConf: ocr.avgConf });

    // Render gold chart and overlays using the auto renderer if available
    statusEl.textContent = 'Rendering golden chart...';
    let renderRes = null;
    try {
      // Prefer the dedicated auto renderer which infers scale and paints
      if (typeof renderGoldenChartFromFile === 'function') {
        renderRes = await renderGoldenChartFromFile(canvas, file);
      } else {
        renderRes = await renderAndAnnotate(canvas, file, parsed, decision, { avgConf: ocr.avgConf });
      }
    } catch (err) {
      // fallback to internal painting
      await renderAndAnnotate(canvas, file, parsed, decision, { avgConf: ocr.avgConf });
    }

    // Save results for options page
    try {
      localStorage.setItem('gf_data', JSON.stringify(parsed));
      localStorage.setItem('gf_decision', JSON.stringify(decision));
      localStorage.setItem('gf_last_ocr_confidence', String(ocr.avgConf || 0));
      localStorage.setItem('gf_last_analysis_time', nowISO());
    } catch (e) {
      // ignore storage errors
    }

    // Output summary and long narrative
    let summaryHtml = `<div class="sim-summary">`;
    summaryHtml += `<p style="color:#d4af37"><strong>OCR confidence</strong>: ${(ocr.avgConf || 0).toFixed(1)}%</p>`;
    if (decision && decision.valid) {
      summaryHtml += `<p style="color:#cfcfcf"><strong>Decision</strong>: ${decision.direction.toUpperCase()}</p>`;
      summaryHtml += `<p style="color:#cfcfcf">Entry: ${decision.entry} • Stop: ${decision.stop} • Target: ${decision.target}</p>`;
    } else {
      summaryHtml += `<p style="color:#ffb3b3"><strong>No clean setup detected</strong></p>`;
    }
    summaryHtml += `</div>`;
    outEl.innerHTML = summaryHtml + `<div style="margin-top:12px">${narrative}</div>`;

    // Debug log
    const debug = { parsed, decision, ocr: { avgConf: ocr.avgConf }, axis: axis, detectors, renderRes };
    logEl.innerHTML = `<pre class="debug">${JSON.stringify(debug, null, 2)}</pre>`;

    statusEl.textContent = 'Analysis complete';
    return { ok: true, parsed, decision, ocr, axis, detectors, renderRes };
  } catch (err) {
    console.error('Processing error', err);
    document.getElementById(STATUS_ID).textContent = 'Could not process image';
    document.getElementById(OUTPUT_ID).innerHTML = `<p style="color:#ff8a8a">Error: ${err?.message || 'Unknown error'}</p>`;
    document.getElementById(LOG_ID).textContent = String(err?.stack || err);
    return { ok: false, error: err };
  }
}

// Wiring: click + drag/drop
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

  if (canvas) canvas.addEventListener('click', () => fileInput.click());

  statusEl.textContent = 'Ready. Drop a chart or click to upload.';
});
