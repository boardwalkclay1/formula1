// options.js — Golden Chain + Golden Chart
import { pickOptionsContract, dynamicStep } from "./core.js";
import "./rules.js";

function drawGoldenChart(canvasId, data, decision) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');

  const price   = data.price   || 0;
  const dayHigh = data.dayHigh || price * 1.02;
  const dayLow  = data.dayLow  || price * 0.98;

  const entry  = Number(decision.entry || price);
  const stop   = Number(decision.stop || price * 0.95);
  const target = Number(decision.target || price * 1.05);

  const minP = Math.min(dayLow, stop, price);
  const maxP = Math.max(dayHigh, target, price);

  const pad = 30;
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, w, h);

  function yFor(p) {
    if (maxP === minP) return h / 2;
    return h - pad - ((p - minP) / (maxP - minP)) * (h - pad * 2);
  }

  // Price marker
  ctx.fillStyle = "#d4af37";
  ctx.beginPath();
  ctx.arc(w * 0.2, yFor(price), 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d4af37";
  ctx.fillText(`Price ${price.toFixed(2)}`, w * 0.2 + 10, yFor(price) + 4);

  // Entry line
  ctx.strokeStyle = "#3cff9d";
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(w * 0.1, yFor(entry));
  ctx.lineTo(w * 0.9, yFor(entry));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#3cff9d";
  ctx.fillText(`Entry ${entry.toFixed(2)}`, w * 0.1, yFor(entry) - 5);

  // Stop line
  ctx.strokeStyle = "#ff4b4b";
  ctx.beginPath();
  ctx.moveTo(w * 0.1, yFor(stop));
  ctx.lineTo(w * 0.9, yFor(stop));
  ctx.stroke();
  ctx.fillStyle = "#ff4b4b";
  ctx.fillText(`Stop ${stop.toFixed(2)}`, w * 0.1, yFor(stop) - 5);

  // Target line
  ctx.strokeStyle = "#4bb8ff";
  ctx.beginPath();
  ctx.moveTo(w * 0.1, yFor(target));
  ctx.lineTo(w * 0.9, yFor(target));
  ctx.stroke();
  ctx.fillStyle = "#4bb8ff";
  ctx.fillText(`Target ${target.toFixed(2)}`, w * 0.1, yFor(target) - 5);
}

document.addEventListener("DOMContentLoaded", () => {
  const decision = JSON.parse(localStorage.getItem("gf_decision") || "{}");
  const data = JSON.parse(localStorage.getItem("gf_data") || "{}");

  const runBtn = document.getElementById("runOptions");
  const recEl = document.getElementById("opt-recommended");
  const chainEl = document.getElementById("opt-chain");
  const notesEl = document.getElementById("opt-notes");

  // Draw initial chart (even if no trade)
  drawGoldenChart("opt-canvas", data, decision || {});

  runBtn.addEventListener("click", () => {
    const days = Number(document.getElementById("expiry").value);
    const ticker = document.getElementById("ticker").value.trim().toUpperCase() || "TICKER";

    // If no valid trade, we still give guidance: stand aside
    if (!decision || !decision.valid) {
      recEl.innerHTML = `
        <h2>No Trade – Stand Aside</h2>
        <p>The simulator did not find a clean, high‑conviction setup.</p>
        <p>This is still a decision: choosing not to trade is part of being a professional.</p>
      `;
      chainEl.innerHTML = "";
      notesEl.innerHTML = `
        <p>No rule fired strongly enough to justify risk.</p>
        <p>Wait for a clearer alignment of price, moving averages, and pattern before touching options.</p>
      `;
      return;
    }

    const plan = pickOptionsContract(decision, days, ticker);

    // Draw chart with entry/stop/target
    drawGoldenChart("opt-canvas", data, decision);

    // Recommended contract
    const rec = plan.recommended;
    recEl.innerHTML = `
      <div class="opt-card opt-recommended">
        <h2>⭐ Recommended Contract</h2>
        <p><strong>${rec.label}</strong></p>
        <p>Moneyness: ${rec.moneyness}</p>
        <p>${rec.styleHint}</p>
      </div>
    `;

    // Full chain around entry
    const entry = Number(decision.entry);
    const step = dynamicStep(entry);
    const strikes = [];
    for (let i = -7; i <= 7; i++) {
      strikes.push(Math.round((entry + i * step) * 100) / 100);
    }

    chainEl.innerHTML = strikes.map(strike => {
      const label = `${ticker} ${strike} ${decision.direction.toUpperCase()}`;
      const isRec = strike === rec.strike;
      const moneyness =
        decision.direction === "call"
          ? (strike < entry ? "ITM" : strike === entry ? "ATM" : "OTM")
          : (strike > entry ? "ITM" : strike === entry ? "ATM" : "OTM");

      return `
        <div class="opt-card ${isRec ? "opt-highlight" : ""}">
          <p><strong>${label}</strong></p>
          <p>${moneyness}</p>
        </div>
      `;
    }).join("");

    notesEl.innerHTML = plan.notes.map(n => `<p>${n}</p>`).join("");
  });
});
