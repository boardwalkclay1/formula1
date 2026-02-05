// simulator.js
import { parseChartText, decideTrade, simulateFuture } from './core-logic.js';

function drawSimulation(canvasId, data, decision) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');

  const price = data.price || 0;
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

  // future path
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

  const decision = decideTrade(data);

  const out = document.getElementById("sim-output");
  const logEl = document.getElementById("sim-log");

  if (decision.direction === "none") {
    out.innerHTML = `
      <h2>No Simple Trade</h2>
      <p>The rules did not find a clean, obvious setup.</p>
    `;
  } else {
    const dirText = decision.direction === "call" ? "CALL (upside)" : "PUT (downside)";
    const waitText = decision.wait ? "WAIT for price to come back to your level." : "OK to ENTER near this level.";
    out.innerHTML = `
      <h2>Prediction</h2>
      <p><strong>Direction:</strong> ${dirText}</p>
      <p><strong>Entry:</strong> ${decision.entry}</p>
      <p><strong>Stop loss:</strong> ${decision.stop}</p>
      <p><strong>Target:</strong> ${decision.target}</p>
      <p><strong>Plan:</strong> ${waitText}</p>
    `;
  }

  logEl.textContent = decision.log.join("\n");

  drawSimulation("sim-canvas", data, decision);
}

function runOCR(file) {
  const status = document.getElementById("sim-status");
  status.textContent = "Reading chart...";
  Tesseract.recognize(file, 'eng').then(({ data }) => {
    status.textContent = "Chart read. Running logic...";
    handleText(data.text || "");
  }).catch(() => {
    status.textContent = "Could not read image.";
  });
}

function setupDropZone() {
  const zone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const status = document.getElementById("sim-status");

  ["dragenter", "dragover", "dragleave", "drop"].forEach(eventName => {
    zone.addEventListener(eventName, e => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  zone.addEventListener("dragover", () => {
    zone.classList.add("drag-over");
  });

  zone.addEventListener("dragleave", () => {
    zone.classList.remove("drag-over");
  });

  zone.addEventListener("drop", e => {
    zone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) runOCR(file);
  });

  zone.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", e => {
    const file = e.target.files[0];
    if (file) runOCR(file);
  });

  status.textContent = "Drag & drop a Webull screenshot here, or click to upload.";
}

document.addEventListener("DOMContentLoaded", setupDropZone);
