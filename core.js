// core.js

// ---------- BASIC HELPERS ----------
export function nearestEven(price) { return Math.round(price / 5) * 5; }
export function nextEvenUp(price)  { return Math.ceil(price / 5) * 5; }
export function nextEvenDown(p)    { return Math.floor(p / 5) * 5; }

// ---------- PARSE WEBULL / RIOT / AVGO TEXT ----------
export function parseChartText(raw) {
  let text = raw
    .replace(/\s+/g, ' ')
    .replace(/–|—/g, '-')
    .replace(/[^0-9a-zA-Z\.\:\-\/ ]/g, '')
    .replace(/(\d)\s+(\d)/g, '$1$2');

  const out = {};

  const priceMatch =
    text.match(/RIOT[^0-9]*([0-9]+\.[0-9]+)/i) ||
    text.match(/AVGO[^0-9]*([0-9]+\.[0-9]+)/i) ||
    text.match(/([0-9]+\.[0-9]+)\s*[▲▼\+\-]/);
  if (priceMatch) out.price = parseFloat(priceMatch[1]);

  const hlMatch = text.match(/H\/L[^0-9]*([0-9]+\.[0-9]+)-([0-9]+\.[0-9]+)/i);
  if (hlMatch) {
    out.dayHigh = parseFloat(hlMatch[1]);
    out.dayLow  = parseFloat(hlMatch[2]);
  }

  const ma20 = text.match(/MA20[: ]*([0-9]+\.[0-9]+)/i);
  const ma50 = text.match(/MA50[: ]*([0-9]+\.[0-9]+)/i);
  const ma200 = text.match(/MA200[: ]*([0-9]+\.[0-9]+)/i);

  if (ma20)  out.maFast = parseFloat(ma20[1]);
  if (ma50)  out.maSlow = parseFloat(ma50[1]);
  if (ma200) out.ma200  = parseFloat(ma200[1]);

  return out;
}

// ---------- BULLISH FLAG DETECTOR ----------
export function detectBullFlag(data) {
  const { price, dayHigh, dayLow, maFast, maSlow, ma200 } = data;

  if ([price, dayHigh, dayLow, maFast, maSlow].some(v => v == null || isNaN(v))) {
    return { isFlag: false, notes: [] };
  }

  const notes = [];
  const range = dayHigh - dayLow;
  if (range <= 0) return { isFlag: false, notes };

  const pos = (price - dayLow) / range;
  if (pos < 0.6) return { isFlag: false, notes };
  notes.push("Price is holding in the upper part of today’s range.");

  if (!(price > maFast && price > maSlow)) return { isFlag: false, notes };
  notes.push("Price is above both fast and slow moving averages.");

  const diffFS = Math.abs(maFast - maSlow);
  if (diffFS > price * 0.01) return { isFlag: false, notes };
  notes.push("Fast and slow MAs are tight → consolidation.");

  if (!isNaN(ma200)) {
    const maxMA = Math.max(maFast, maSlow, ma200);
    const minMA = Math.min(maFast, maSlow, ma200);
    if ((maxMA - minMA) > price * 0.02) return { isFlag: false, notes };
    notes.push("20 / 50 / 200 MAs are clustered → strong trend.");
  }

  notes.push("Bullish flag golden play detected.");
  return { isFlag: true, notes };
}

// ---------- RULE SYSTEM ----------
const rules = [];
export function addRule(rule) { rules.push(rule); }

// ---------- DECISION ENGINE ----------
export function decideTrade(data) {
  const notes = [];

  for (const rule of rules) {
    notes.push(`Checking rule: ${rule.name}`);
    const res = rule.check(data, notes);
    if (res) {
      notes.push(`Rule fired: ${rule.name}`);
      return { ...res, valid: true, notes };
    }
  }

  notes.push("No rule fired → no simple trade.");
  return { direction: "none", valid: false, entry: "", stop: "", target: "", wait: true, notes };
}

// ---------- FUTURE SIMULATION ----------
export function simulateFuture(data, decision) {
  const price = data.price || 0;
  const candles = [];
  const steps = 30;

  if (!decision.valid) {
    for (let i = 0; i < steps; i++) {
      candles.push(price + (Math.random() - 0.5) * (price * 0.002));
    }
    return candles;
  }

  let current = price;
  const bias = decision.direction === "call" ? 1 : -1;

  for (let i = 0; i < steps; i++) {
    current += bias * price * 0.003 + (Math.random() - 0.5) * (price * 0.001);
    candles.push(current);
  }

  return candles;
}

// ---------- OPTIONS PICKER ----------
export function pickOptionsContract(decision, daysToExpiry) {
  if (!decision.valid) {
    return {
      directionText: "No clear trade.",
      summary: "The setup is not clean enough to choose a contract.",
      details: []
    };
  }

  const dirText = decision.direction === "call"
    ? "CALL – expecting upside."
    : "PUT – expecting downside.";

  let expiryText = "";
  if (daysToExpiry <= 2) expiryText = "very short‑term scalp.";
  else if (daysToExpiry <= 5) expiryText = "short‑term move.";
  else if (daysToExpiry <= 10) expiryText = "about a week.";
  else if (daysToExpiry <= 20) expiryText = "a couple of weeks.";
  else expiryText = "a swing trade.";

  const details = [
    `Direction: ${dirText}`,
    `Strike near entry: ${decision.entry}`,
    `Stop loss: ${decision.stop}`,
    `Target: ${decision.target}`,
    `Expiration: ${expiryText}`
  ];

  if (decision.wait) {
    details.push("Price is stretched → WAIT for a better entry.");
  } else {
    details.push("Price is close enough → OK to enter.");
  }

  return {
    directionText: dirText,
    summary: "Contract guidance based on your golden rules.",
    details
  };
}
