// simulator.js
import { parseChartText, decideTrade, simulateFuture } from './core.js';

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

  // NOW price marker
  ctx.fillStyle = "#d4af37";
  ctx.beginPath();
  ctx.arc(w * 0.3, yFor(price), 5, 0, Math.PI * 2);
  ctx.fill();

  // Future line
  ctx.strokeStyle = decision.valid ? "#3cff9d" : "#999";
  ctx.lineWidth = 3;
  ctx.beginPath();
  future.forEach((p, i) => {
    const x = w * 0.3 + (i / (future.length - 1 || 1)) * (w * 0.6);
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

  // Save for options page
  localStorage.setItem("gf_data", JSON.stringify(data));
  localStorage.setItem("gf_decision", JSON.stringify(decision));

  const out = document.getElementById("sim-output");
  if (decision.valid) {
    out.innerHTML = `
      <h2>Prediction</h2>
      <p><strong>${decision.direction.toUpperCase()}</strong> – golden rules say this is the side to be on.</p>
      <p><strong>Entry:</strong> ${decision.entry}</p>
      <p><strong>Stop loss:</strong> ${decision.stop}</p>
      <p><strong>Target:</strong> ${decision.target}</p>
      <p><strong>Wait or Enter:</strong> ${decision.wait ? "WAIT for a better price" : "OK to ENTER near this level"}</p>
      <h3>Reasoning</h3>
      <ul>${decision.notes.map(n => `<li>${n}</li>`).join("")}</ul>
    `;
  } else {
    out.innerHTML = `
      <h2>No Simple Trade</h2>
      <ul>${decision.notes.map(n => `<li>${n}</li>`).join("")}</ul>
    `;
  }

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

  zone.addEventListener("dragover", e => {
    e.preventDefault();
    zone.classList.add("drag-over");
  });
  zone.addEventListener("dragleave", e => {
    e.preventDefault();
    zone.classList.remove("drag-over");
  });
  zone.addEventListener("drop", e => {
    e.preventDefault();
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
