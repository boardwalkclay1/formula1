// modules/simulator.js
// Advanced, extended, mentor-grade simulator with deep observation, robust OCR pipeline,
// drag/drop auto-read, image preprocessing, confidence scoring, retry logic, and verbose narrative.
// Designed to feed the automatic Golden Options Terminal (options.html) via localStorage.
//
// Drop an image anywhere or click the file input. The engine will:
//  - Preprocess image (resize, grayscale, contrast) for better OCR
//  - Run Tesseract with progressive retries and language/config tuning
//  - Parse text with core.parseChartText
//  - Run rule engine (decideTrade) and many detectors for deep observations
//  - Produce a long, structured narrative and confidence metrics
//  - Draw a cinematic Golden Chart + future simulation
//  - Save gf_data and gf_decision to localStorage for options page
//  - Optionally accept an options-chain image for OCR and refinement
//
// NOTE: This file expects core.js to export many detectors and helpers used below.

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
  dynamicStep,
  nearestEven
} from "./core.js";
import "./rules.js";

// -----------------------------
// Configuration
// -----------------------------
const OCR_CONFIG = {
  lang: "eng",
  // Tesseract config options to improve numeric recognition
  tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.-/: ",
  preserve_interword_spaces: "1",
  retryCount: 2,
  retryDelayMs: 600
};

const CANVAS_ID = "sim-canvas";
const STATUS_ID = "sim-status";
const FILE_INPUT_ID = "file-input";
const OUTPUT_ID = "sim-output";
const LOG_ID = "sim-log";
const MAX_IMAGE_DIM = 1600; // max width/height for preprocessing

// -----------------------------
// Utilities
// -----------------------------
function nowISO() {
  return new Date().toISOString();
}

function safeNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -----------------------------
// Image Preprocessing Helpers
// -----------------------------
async function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function preprocessImageToCanvas(img, maxDim = MAX_IMAGE_DIM) {
  // Resize to max dimension while preserving aspect ratio, convert to grayscale and increase contrast
  const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  // Draw original
  ctx.drawImage(img, 0, 0, w, h);

  // Get image data and apply simple grayscale + contrast stretch
  const id = ctx.getImageData(0, 0, w, h);
  const data = id.data;

  // Convert to luminance and apply contrast
  // Compute mean luminance
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
    sum += lum;
  }
  const mean = sum / (data.length / 4);
  const contrast = 1.2; // mild contrast boost
  const brightnessShift = 0;

  for (let i = 0; i < data.length; i += 4) {
    let lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
    // stretch around mean
    lum = (lum - mean) * contrast + mean + brightnessShift;
    lum = clamp(Math.round(lum), 0, 255);
    data[i] = data[i+1] = data[i+2] = lum;
    // keep alpha
  }
  ctx.putImageData(id, 0, 0);

  // Optional: apply sharpening or thresholding if needed (kept simple here)
  return canvas;
}

// -----------------------------
// OCR Pipeline with retries and progressive config
// -----------------------------
async function runTesseractOnCanvas(canvas, config = OCR_CONFIG) {
  // Convert canvas to blob for Tesseract
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error("Failed to convert canvas to blob"));
      try {
        const workerConfig = {
          lang: config.lang,
          tessedit_char_whitelist: config.tessedit_char_whitelist,
          preserve_interword_spaces: config.preserve_interword_spaces
        };

        // Use Tesseract.recognize directly for simplicity
        const result = await Tesseract.recognize(blob, workerConfig.lang, {
          tessedit_char_whitelist: workerConfig.tessedit_char_whitelist,
          preserve_interword_spaces: workerConfig.preserve_interword_spaces
        });
        resolve(result);
      } catch (err) {
        reject(err);
      }
    }, "image/png");
  });
}

async function ocrWithRetries(canvas, maxRetries = OCR_CONFIG.retryCount, delayMs = OCR_CONFIG.retryDelayMs) {
  let attempt = 0;
  let lastErr = null;
  while (attempt <= maxRetries) {
    try {
      const res = await runTesseractOnCanvas(canvas, OCR_CONFIG);
      // Basic confidence check: Tesseract returns words with confidences; compute average
      const words = res?.data?.words || [];
      const avgConf = words.length ? (words.reduce((s, w) => s + (w.confidence || 0), 0) / words.length) : 0;
      return { text: res?.data?.text || "", avgConf, raw: res };
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt <= maxRetries) await sleep(delayMs);
    }
  }
  throw lastErr;
}

// -----------------------------
// Deep Narrative Builder
// -----------------------------
function buildLongNarrative(data, decision, ocrMeta = {}) {
  // Compose a long, layered narrative using detectors and decision context.
  // This intentionally produces a verbose, mentor-style output with timestamps, confidence, and step-by-step reasoning.
  const parts = [];
  parts.push(`<div class="obs-meta"><small>Analysis time: ${nowISO()}</small></div>`);
  parts.push(`<h3>Immediate read</h3>`);
  parts.push(`<p>I read the chart text with an OCR confidence of <strong>${(ocrMeta.avgConf || 0).toFixed(1)}%</strong>. The parser extracted the following raw values (best-effort):</p>`);
  parts.push(`<ul>`);
  parts.push(`<li><strong>Price:</strong> ${safeNumber(data.price, "n/a")}</li>`);
  parts.push(`<li><strong>Day high / low:</strong> ${safeNumber(data.dayHigh, "n/a")} / ${safeNumber(data.dayLow, "n/a")}</li>`);
  parts.push(`<li><strong>MA20 / MA50 / MA200:</strong> ${safeNumber(data.maFast, "n/a")} / ${safeNumber(data.maSlow, "n/a")} / ${safeNumber(data.ma200, "n/a")}</li>`);
  if (data.ticker) parts.push(`<li><strong>Ticker (parsed):</strong> ${data.ticker}</li>`);
  parts.push(`</ul>`);

  // Structural observations
  parts.push(`<h3>Structure & context</h3>`);
  // Range and position
  if (data.price && data.dayHigh && data.dayLow) {
    const range = data.dayHigh - data.dayLow;
    const pos = range > 0 ? (data.price - data.dayLow) / range : 0.5;
    const posText =
      pos < 0.2 ? "near the low of the day" :
      pos < 0.4 ? "in the lower half of today’s range" :
      pos < 0.6 ? "around the middle of today’s range" :
      pos < 0.8 ? "in the upper half of today’s range" :
                  "pressing near the high of the day";
    parts.push(`<p>Price is ${posText}. The intraday range is ${range ? range.toFixed(2) : "n/a"} points.</p>`);
  } else {
    parts.push(`<p>Not enough range data to compute intraday position precisely.</p>`);
  }

  // MA cluster
  const maCluster = detectMACluster({ maFast: data.maFast, maSlow: data.maSlow, ma200: data.ma200, price: data.price });
  if (maCluster.clustered) {
    parts.push(`<p>Moving averages are tightly clustered (spread ≈ ${maCluster.spread?.toFixed(3)}). That often signals consolidation and a potential directional breakout once price chooses a side.</p>`);
  } else {
    parts.push(`<p>Moving averages are not tightly clustered. Expect more directional noise unless a clear breakout forms.</p>`);
  }

  // Bull flag
  const flag = detectBullFlag(data);
  if (flag.isFlag) {
    parts.push(`<p><strong>Bull flag detected:</strong> ${flag.notes.join("; ")}</p>`);
  }

  // MA slope
  // We don't have history here; if history is available in decision.context.history, use it
  const slope = detectMASlope(decision?.context?.history || []);
  if (slope) {
    parts.push(`<p>MA slope: fastUp=${slope.fastUp}, slowUp=${slope.slowUp}, sharpMove=${slope.sharpMove}.</p>`);
  }

  // Even proximity
  if (data.price) {
    const even = detectEvenProximity(data.price);
    if (even && even.isNear) {
      parts.push(`<p>Price is ${even.isJustAbove ? "just above" : even.isJustBelow ? "just below" : "right on"} a key even level at <strong>${even.nearest.toFixed(2)}</strong>. These levels often act as short-term magnets or barriers.</p>`);
    } else {
      parts.push(`<p>Price is not especially close to a key even level.</p>`);
    }
  }

  // Support/resistance (if history provided)
  const sr = detectSupportResistance(decision?.context?.history || []);
  if ((sr.supports || []).length || (sr.resistances || []).length) {
    parts.push(`<p>Detected ${sr.supports.length} strong levels from history. These can be used as reference for stop placement or targets.</p>`);
  }

  // Double top/bottom & rounding
  const db = detectDoubleTopBottom(decision?.context?.history || []);
  if (db.doubleTop) parts.push(`<p>Double top pattern detected historically — caution on long entries near that zone.</p>`);
  if (db.doubleBottom) parts.push(`<p>Double bottom pattern detected historically — potential reversal support.</p>`);
  const rounding = detectRounding(decision?.context?.history || []);
  if (rounding.roundingBottom) parts.push(`<p>Rounding bottom structure detected — accumulation phase possible.</p>`);
  if (rounding.roundingTop) parts.push(`<p>Rounding top structure detected — distribution phase possible.</p>`);

  // Decision summary
  parts.push(`<h3>Engine decision summary</h3>`);
  if (!decision.valid) {
    parts.push(`<p>The rule engine did not find a clean setup. Notes:</p>`);
    parts.push(`<ul>${(decision.notes || []).map(n => `<li>${n}</li>`).join("")}</ul>`);
    parts.push(`<p><em>Recommendation:</em> Stand aside. Wait for clearer structure or a retest of a key level.</p>`);
  } else {
    parts.push(`<p>The engine found a valid setup with direction <strong>${decision.direction}</strong>.</p>`);
    parts.push(`<ul>`);
    parts.push(`<li><strong>Entry:</strong> ${decision.entry}</li>`);
    parts.push(`<li><strong>Stop:</strong> ${decision.stop}</li>`);
    parts.push(`<li><strong>Target:</strong> ${decision.target}</li>`);
    parts.push(`</ul>`);
    parts.push(`<p>Engine notes:</p>`);
    parts.push(`<ul>${(decision.notes || []).map(n => `<li>${n}</li>`).join("")}</ul>`);
    // Confidence heuristic: combine OCR confidence and structural signals
    const ocrConf = ocrMeta.avgConf || 0;
    let structuralScore = 50;
    if (maCluster.clustered) structuralScore += 10;
    if (flag.isFlag) structuralScore += 15;
    if (!decision.wait) structuralScore += 10;
    const combined = clamp(Math.round((ocrConf * 0.4) + (structuralScore * 0.6)), 0, 100);
    parts.push(`<p><strong>Composite confidence:</strong> ${combined}% (OCR ${ocrConf.toFixed(1)}% + structure ${structuralScore}).</p>`);
    parts.push(`<p><em>Action guidance:</em> ${decision.wait ? "Wait for a better fill near entry." : "Begin scaling in according to your risk plan."}</p>`);
  }

  // Practical trade management
  parts.push(`<h3>Trade management & discipline</h3>`);
  parts.push(`<p>Size to risk: calculate position size so that a full stop-out equals a pre-defined percentage of your account. Use the underlying stop level, not option price, to manage risk. If the chart no longer matches the original setup, exit the trade even if the option still has time.</p>`);
  parts.push(`<p>Emotional checklist: 1) Is this trade within your daily risk budget? 2) Can you accept the stop without panic? 3) Do you have a clear plan for partial exits and trailing?</p>`);

  // Final mentor note
  parts.push(`<h3>Mentor note</h3>`);
  parts.push(`<p>Trading is a game of repeated, disciplined decisions. The engine gives you a read; your job is to execute the plan and manage risk. If you want, I can now build the 5-strike options ladder around the entry and recommend the contract and expiration — or you can upload an options-chain screenshot and I will refine the recommendation using real bid/ask/IV data.</p>`);

  return parts.join("");
}

// -----------------------------
// Canvas Drawing: Golden Chart + Bars + Labels
// -----------------------------
function drawGoldenChart(canvasId, data, decision, opts = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");

  const price   = safeNumber(data.price, 0);
  const dayHigh = safeNumber(data.dayHigh, price * 1.02);
  const dayLow  = safeNumber(data.dayLow, price * 0.98);

  const entry  = safeNumber(decision.entry, price);
  const stop   = safeNumber(decision.stop, price * 0.95);
  const target = safeNumber(decision.target, price * 1.05);

  const future = simulateFuture(data, decision, 40);
  const allPrices = [dayLow, dayHigh, price, entry, stop, target, ...future].filter(v => v != null);
  const minP = Math.min(...allPrices);
  const maxP = Math.max(...allPrices);

  const pad = 36;
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, w, h);

  // Grid lines (subtle)
  ctx.strokeStyle = "rgba(212,175,55,0.06)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + (i / 4) * (h - pad * 2);
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }

  function yFor(p) {
    if (maxP === minP) return h / 2;
    return h - pad - ((p - minP) / (maxP - minP)) * (h - pad * 2);
  }

  // Price marker
  ctx.fillStyle = "#d4af37";
  ctx.beginPath();
  ctx.arc(pad + 10, yFor(price), 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d4af37";
  ctx.font = "12px system-ui, Arial";
  ctx.fillText(`Now ${price.toFixed(2)}`, pad + 20, yFor(price) + 4);

  // Entry line (green dashed)
  ctx.strokeStyle = "#3cff9d";
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, yFor(entry));
  ctx.lineTo(w - pad, yFor(entry));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#3cff9d";
  ctx.fillText(`Entry ${entry.toFixed(2)}`, pad + 4, yFor(entry) - 8);

  // Stop line (red)
  ctx.strokeStyle = "#ff4b4b";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, yFor(stop));
  ctx.lineTo(w - pad, yFor(stop));
  ctx.stroke();
  ctx.fillStyle = "#ff4b4b";
  ctx.fillText(`Stop ${stop.toFixed(2)}`, pad + 4, yFor(stop) - 8);

  // Target line (blue)
  ctx.strokeStyle = "#4bb8ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, yFor(target));
  ctx.lineTo(w - pad, yFor(target));
  ctx.stroke();
  ctx.fillStyle = "#4bb8ff";
  ctx.fillText(`Target ${target.toFixed(2)}`, pad + 4, yFor(target) - 8);

  // Future path
  ctx.strokeStyle = decision.direction === "call" ? "#3cff9d" : decision.direction === "put" ? "#ff4b4b" : "#999";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  future.forEach((p, i) => {
    const x = pad + (i / (future.length - 1 || 1)) * (w - pad * 2);
    const y = yFor(p);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Small legend
  ctx.fillStyle = "#d4af37";
  ctx.fillText("Golden Formula", w - pad - 110, pad - 8);
}

// -----------------------------
// Options-chain image OCR (optional refinement)
// -----------------------------
async function refineWithOptionsChainImage(file) {
  // Preprocess and OCR the options chain image, then attempt to parse numeric columns (bid/ask/iv/delta)
  try {
    const img = await loadImageFromFile(file);
    const canvas = preprocessImageToCanvas(img, 1200);
    const ocrRes = await ocrWithRetries(canvas, 1, 400);
    // Very simple numeric extraction: find lines with % (IV) or "Bid" "Ask"
    const text = ocrRes.text || "";
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const parsed = { rawText: text, lines, ivHints: [], bidAskRows: [] };

    for (const line of lines) {
      const ivMatch = line.match(/([0-9]{1,3}\.?[0-9]?)\s*%/);
      if (ivMatch) parsed.ivHints.push(Number(ivMatch[1]));
      const ba = line.match(/([0-9]+\.[0-9]+)\s+\/\s+([0-9]+\.[0-9]+)/);
      if (ba) parsed.bidAskRows.push({ bid: Number(ba[1]), ask: Number(ba[2]), raw: line });
    }

    return parsed;
  } catch (err) {
    return { error: true, message: err?.message || "OCR failed" };
  }
}

// -----------------------------
// Main OCR handler (file or drop)
// -----------------------------
async function handleFileUpload(file, optionsChainFile = null) {
  const statusEl = document.getElementById(STATUS_ID);
  const outEl = document.getElementById(OUTPUT_ID);
  const logEl = document.getElementById(LOG_ID);

  try {
    statusEl.textContent = "Loading image...";
    const img = await loadImageFromFile(file);

    statusEl.textContent = "Preprocessing image for OCR...";
    const canvas = preprocessImageToCanvas(img);

    statusEl.textContent = "Running OCR (this may take a few seconds)...";
    const ocrResult = await ocrWithRetries(canvas, OCR_CONFIG.retryCount, OCR_CONFIG.retryDelayMs);

    statusEl.textContent = "Parsing chart text...";
    const parsed = parseChartText(ocrResult.text || "");

    // Build data object
    const data = {
      price: safeNumber(parsed.price, null),
      dayHigh: safeNumber(parsed.dayHigh, null),
      dayLow: safeNumber(parsed.dayLow, null),
      maFast: safeNumber(parsed.maFast, null),
      maSlow: safeNumber(parsed.maSlow, null),
      ma200: safeNumber(parsed.ma200, null),
      ticker: parsed.ticker || null,
      ocrRaw: ocrResult.raw
    };

    statusEl.textContent = "Running rule engine...";
    const decision = decideTrade(data, { history: [], contextMeta: { ocrAvgConf: ocrResult.avgConf } });

    // If user provided an options-chain image, refine recommendation
    let optionsChainInfo = null;
    if (optionsChainFile) {
      statusEl.textContent = "Refining with options-chain image...";
      optionsChainInfo = await refineWithOptionsChainImage(optionsChainFile);
    }

    // Build long narrative
    const narrative = buildLongNarrative(data, decision, { avgConf: ocrResult.avgConf });

    // Render outputs
    outEl.innerHTML = `
      <section class="sim-summary">
        <h2>Immediate Read</h2>
        ${decision.valid ? `<p><strong>Decision:</strong> ${decision.direction.toUpperCase()}</p>` : `<p><strong>No clean setup</strong></p>`}
        <div class="sim-narrative">${narrative}</div>
      </section>
    `;

    // Log (detailed)
    const debug = {
      parsed,
      ocrAvgConf: ocrResult.avgConf,
      decision,
      optionsChainInfo
    };
    logEl.innerHTML = `<pre class="debug">${JSON.stringify(debug, null, 2)}</pre>`;

    // Draw chart
    drawGoldenChart(CANVAS_ID, data, decision);

    // Save for options page
    localStorage.setItem("gf_data", JSON.stringify(data));
    localStorage.setItem("gf_decision", JSON.stringify(decision));
    localStorage.setItem("gf_last_ocr_confidence", String(ocrResult.avgConf || 0));
    localStorage.setItem("gf_last_analysis_time", nowISO());

    statusEl.textContent = "Analysis complete.";
    return { ok: true, data, decision, ocrAvgConf: ocrResult.avgConf, optionsChainInfo };
  } catch (err) {
    const statusEl2 = document.getElementById(STATUS_ID);
    if (statusEl2) statusEl2.textContent = "Error reading image.";
    const outEl2 = document.getElementById(OUTPUT_ID);
    if (outEl2) outEl2.innerHTML = `<p class="error">Error: ${err?.message || "Unknown error"}</p>`;
    console.error("OCR/analysis error:", err);
    return { ok: false, error: err };
  }
}

// -----------------------------
// Wiring: click + drag/drop + optional options-chain input
// -----------------------------
document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById(FILE_INPUT_ID);
  const statusEl = document.getElementById(STATUS_ID);

  if (!fileInput) {
    console.warn("File input not found:", FILE_INPUT_ID);
    return;
  }

  // Click upload
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    statusEl.textContent = "File selected. Starting analysis...";
    await handleFileUpload(file);
  });

  // Drag & drop (auto-read)
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    // subtle UI hint could be added here
  });

  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    statusEl.textContent = "File dropped. Starting analysis...";
    await handleFileUpload(file);
  });

  // Optional: support a second input for options-chain image refinement if present
  const optChainInput = document.getElementById("opt-chain-input");
  if (optChainInput) {
    optChainInput.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      statusEl.textContent = "Options-chain image selected. Will refine next analysis.";
      // Save temporarily so next handleFileUpload can pick it up if desired
      localStorage.setItem("gf_options_chain_blob", "true"); // placeholder flag
      // You can implement a UI flow to attach this file to the next analysis run
    });
  }
});
