// options.js
import { pickOptionsContract } from './core.js';

function initOptions() {
  const decisionRaw = localStorage.getItem("gf_decision");
  const decision = decisionRaw ? JSON.parse(decisionRaw) : null;

  const out = document.getElementById("options-output");
  const daysInput = document.getElementById("days");

  if (!decision) {
    out.innerHTML = "<h2>No Simulation Data</h2><p>Run the simulator first.</p>";
    return;
  }

  function render() {
    const days = parseInt(daysInput.value || "5", 10);
    const idea = pickOptionsContract(decision, days);

    out.innerHTML = `
      <h2>Options Idea</h2>
      <p><strong>${idea.directionText}</strong></p>
      <p>${idea.summary}</p>
      <ul>${idea.details.map(d => `<li>${d}</li>`).join("")}</ul>
    `;
  }

  daysInput.addEventListener("input", render);
  render();
}

document.addEventListener("DOMContentLoaded", initOptions);
