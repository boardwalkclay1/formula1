// modules/options.js — automatic Golden Options Terminal
import { pickOptionsContract, dynamicStep, simulateFuture } from "./core.js";
import "./rules.js";

function drawGoldenChart(canvasId, data, decision) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");

  const price   = Number(data.price)   || 0;
  const dayHigh = Number(data.dayHigh) || price * 1.02;
  const dayLow  = Number(data.dayLow)  || price * 0.98;

  const entry  = Number(decision.entry || price);
  const stop   = Number(decision.stop  || price * 0.95);
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

  // Future path (Golden prediction)
  const future = simulateFuture(data, decision) || [];
  if (future.length) {
    ctx.strokeStyle = decision.direction === "call" ? "#3cff9d" :
                      decision.direction === "put"  ? "#ff4b4b" : "#999";
    ctx.lineWidth = 2;
    ctx.beginPath();
    future.forEach((p, i) => {
      const x = w * 0.2 + (i / (future.length - 1 || 1)) * (w * 0.6);
      const y = yFor(p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

function buildFiveStrikeLadder(entry, direction, ticker, plan) {
  const step = dynamicStep(entry);
  const strikes = [
    entry - 2 * step,
    entry - 1 * step,
    entry,
    entry + 1 * step,
    entry + 2 * step
  ].map(s => Math.round(s * 100) / 100);

  const rec = plan.recommended;
  return strikes.map((strike, idx) => {
    const label = `${ticker} ${strike} ${direction.toUpperCase()}`;
    const isRec = rec && strike === rec.strike;
    const position = ["Deep ITM", "ITM", "ATM", "OTM", "Deep OTM"][idx];

    let guidance = "";
    if (isRec) {
      guidance = "This is the balance between risk, cost, and alignment with the setup. This is the one I’d take.";
    } else if (idx < 2) {
      guidance = "Safer but more expensive. Slower move, less theta burn, but you pay for safety.";
    } else if (idx === 2) {
      guidance = "Pure alignment with the level. Cleanest read, but you must respect your stop.";
    } else if (idx === 3) {
      guidance = "More aggressive. Cheaper, but you need the move to actually happen.";
    } else {
      guidance = "Lottery ticket territory. Only makes sense if the setup is extremely strong — usually I avoid this.";
    }

    return { strike, label, isRec, position, guidance };
  });
}

function buildDisciplineBlock(decision) {
  const dirText = decision.direction === "call" ? "CALL (upside)" :
                  decision.direction === "put"  ? "PUT (downside)" :
                  "No clear direction";

  const strengthHint = decision.valid
    ? "This setup passed my filters. That doesn’t mean it’s guaranteed — it means it’s clean enough to consider."
    : "This setup did not pass my filters. Standing aside is still a decision, and often the best one.";

  return `
    <p><strong>Direction:</strong> ${dirText}</p>
    <p>${strengthHint}</p>
    <p>
      Your job is not to predict the future — it’s to follow the plan. If you take this trade,
      you respect the entry, you respect the stop, and you don’t chase if price runs away.
    </p>
    <p>
      Never size a trade based on hope. Size it based on the distance between entry and stop,
      and only risk what you’re truly willing to lose on a single idea.
    </p>
  `;
}

document.addEventListener("DOMContentLoaded", () => {
  const decision = JSON.parse(localStorage.getItem("gf_decision") || "{}");
  const data = JSON.parse(localStorage.getItem("gf_data") || "{}");

  const summaryEl     = document.getElementById("opt-summary");
  const recEl         = document.getElementById("opt-recommended");
  const chainEl       = document.getElementById("opt-chain");
  const notesEl       = document.getElementById("opt-notes");
  const disciplineEl  = document.getElementById("opt-discipline");

  if (!decision || !decision.entry || !decision.direction) {
    summaryEl.innerHTML = `
      <h2>No Active Setup</h2>
      <p>
        I don’t have a valid trade from the simulator yet. Go back, upload a chart, and let me
        read it first.
      </p>
    `;
    return;
  }

  // Ticker: try to infer, fallback to generic
  const ticker = (decision.ticker || data.ticker || "TICKER").toUpperCase();

  // Draw Golden Chart
  drawGoldenChart("opt-canvas", data, decision);

  // Build options plan from your core
  const plan = pickOptionsContract(decision, null, ticker); // expiration logic handled inside core

  // Summary
  const dirText = decision.direction === "call" ? "CALL (upside)" : "PUT (downside)";
  summaryEl.innerHTML = `
    <h2>Clayvonte’s Options Read</h2>
    <p><strong>Direction:</strong> ${dirText}</p>
    <p><strong>Entry:</strong> ${decision.entry}</p>
    <p><strong>Stop:</strong> ${decision.stop}</p>
    <p><strong>Target:</strong> ${decision.target}</p>
  `;

  // Recommended contract
  const rec = plan.recommended;
  recEl.innerHTML = `
    <div class="opt-card opt-recommended">
      <p><strong>${rec.label}</strong></p>
      <p>Moneyness: ${rec.moneyness}</p>
      <p>${rec.styleHint}</p>
    </div>
 `;

  // 5‑strike ladder centered on ENTRY
  const entry = Number(decision.entry);
  const ladder = buildFiveStrikeLadder(entry, decision.direction, ticker, plan);

  chainEl.innerHTML = ladder.map(item => `
    <div class="opt-card ${item.isRec ? "opt-highlight" : ""}">
      <p><strong>${item.label}</strong></p>
      <p>${item.position}</p>
      <p>${item.guidance}</p>
    </div>
  `).join("");

  // Notes from engine
  notesEl.innerHTML = (plan.notes || decision.notes || [])
    .map(n => `<p>${n}</p>`)
    .join("");

  // Discipline block
  disciplineEl.innerHTML = buildDisciplineBlock(decision);
});
