// simulator.js — FULLY FIXED, ALWAYS-FIRES VERSION
import { 
  parseChartText, 
  decideTrade, 
  simulateFuture 
} from './core.js';

// 🔥 MOST IMPORTANT: LOAD THE RULES
import './rules.js';

// ------------------------------------------------------------
//  DRAW FUTURE SIMULATION
// ------------------------------------------------------------
function drawSimulation(canvasId, data, decision) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');

  const price   = data.price   || 0;
  const dayHigh = data.dayHigh || price * 1.02;
  const dayLow  = data.dayLow  || price * 0.98;

  const future = simulateFuture(data, decision);
  const allPrices = [dayLow, dayHigh, price, ...future];
  const minP = Math.min(...allPrices);
  const maxP = Math.max(...allPrices);

  const pad = 20;
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, w, h);

  function yFor(p) {
    if (maxP === minP) return h / 2;
    return h - pad - ((p - minP) / (maxP - minP)) * (h - pad * 2);
  }

  // NOW marker
  ctx.fillStyle = "#d4af37";
  ctx.beginPath();
  ctx.arc(w * 0.25, yFor(price), 5, 0, Math.PI * 2);
  ctx.fill();

  // Future path
  ctx.strokeStyle = decision.direction === "call" ? "#3cff9d" :
                    decision.direction === "put"  ? "#ff4b4b" : "#999";
  ctx.lineWidth = 3;
  ctx.beginPath();
  future.forEach((p, i) => {
    const x = w * 0.25 + (i / (future.length - 1 || 1)) * (w * 0.6);
    const y = yFor(p);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// ------------------------------------------------------------
//  HANDLE TEXT → PARSE → DECISION → OUTPUT
// ------------------------------------------------------------
function handleText(text) {
  const parsed = parseChartText(text);

  const data = {
    price:   parsed.price,
    dayHigh: parsed.dayHigh,
    dayLow:  parsed.dayLow,
    maFast:  parsed.maFast,
    maSlow:  parsed.maSlow,
    ma200:   parsed.ma200
  };

  // 🔥 ALWAYS PASS CONTEXT (even if empty for now)
  const decision = decideTrade(data, { history: [] });

  const out = document.getElementById("sim-output");
  const logEl = document.getElementById("sim-log");

  // ------------------------------------------------------------
  //  ADVANCED OUTPUT
  // ------------------------------------------------------------
  if (!decision.valid) {
    out.innerHTML = `
      <h2>No Clean Setup Yet</h2>
      <p>This doesn’t mean the chart is bad — it means the setup isn’t obvious enough yet.</p>
      <p>I only want you taking trades that are clean, simple, and obvious. Anything else is gambling.</p>
    `;
  } else {
    const dirText = decision.direction === "call" ? "CALL (upside)" : "PUT (downside)";
    const waitText = decision.wait 
      ? "WAIT for price to come back to your level — don’t chase." 
      : "Price is close enough — OK to enter near your level.";

    out.innerHTML = `
      <h2>Clayvonte’s Read</h2>
      <p><strong>Direction:</strong> ${dirText}</p>
      <p><strong>Entry:</strong> ${decision.entry}</p>
      <p><strong>Stop loss:</strong> ${decision.stop}</p>
      <p><strong>Target:</strong> ${decision.target}</p>
      <p><strong>Plan:</strong> ${waitText}</p>
    `;
  }

  // ------------------------------------------------------------
  //  ADVANCED NOTES (Clayvonte-style logic)
  // ------------------------------------------------------------
  logEl.innerHTML = decision.notes
    .map(n => `<p>${n}</p>`)
    .join("");

  // ------------------------------------------------------------
  //  DRAW SIMULATION
  // ------------------------------------------------------------
  drawSimulation("sim-canvas", data, decision);

  // ------------------------------------------------------------
  //  SAVE FOR OPTIONS PICKER
  // ------------------------------------------------------------
  localStorage.setItem("gf_decision", JSON.stringify(decision));
}

// ------------------------------------------------------------
//  OCR HANDLER
// ------------------------------------------------------------
function runOCR(file) {
  const status = document.getElementById("sim-status");
  status.textContent = "Reading chart...";

  Tesseract.recognize(file, 'eng')
    .then(({ data }) => {
      status.textContent = "Chart read. Running logic...";
      handleText(data.text || "");
    })
    .catch(() => {
      status.textContent = "Could not read image.";
    });
}

// ------------------------------------------------------------
//  INIT
// ------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("file-input");

  fileInput.addEventListener("change", e => {
    const file = e.target.files[0];
    if (file) runOCR(file);
  });
});
