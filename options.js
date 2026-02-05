// options.js
import { pickOptionsContract } from './core.js';

function initOptions() {
  const dataRaw = localStorage.getItem("gf_decision");
  const decision = dataRaw ? JSON.parse(dataRaw) : null;

  const out = document.getElementById("options-output");
  if (!decision) {
    out.innerHTML = "<h2>No Simulation Data</h2><p>Run the simulator first by dropping a chart.</p>";
    return;
  }

  const daysInput = document.getElementById("days");
  const render = () => {
    const days = parseInt(daysInput.value || "5", 10);
    const idea = pickOptionsContract(decision, days);
    out.innerHTML = `
      <h2>Options Idea</h2>
      <p><strong>${idea.directionText}</strong></p>
      <p>${idea.summary}</p>
      <ul>${idea.details.map(d => `<li>${d}</li>`).join("")}</ul>
    `;
  };

  daysInput.addEventListener("input", render);
  render();
}

document.addEventListener("DOMContentLoaded", initOptions);
