// core.js — FULL MASTER ENGINE
// ------------------------------------------------------------
//  BASIC HELPERS
// ------------------------------------------------------------
export function nearestEven(price) { return Math.round(price / 5) * 5; }
export function nextEvenUp(price)  { return Math.ceil(price / 5) * 5; }
export function nextEvenDown(p)    { return Math.floor(p / 5) * 5; }

// ------------------------------------------------------------
//  TEXT PARSER (Webull / RIOT / AVGO / OCR)
// ------------------------------------------------------------
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

  const ma20  = text.match(/MA20[: ]*([0-9]+\.[0-9]+)/i);
  const ma50  = text.match(/MA50[: ]*([0-9]+\.[0-9]+)/i);
  const ma200 = text.match(/MA200[: ]*([0-9]+\.[0-9]+)/i);

  if (ma20)  out.maFast = parseFloat(ma20[1]);
  if (ma50)  out.maSlow = parseFloat(ma50[1]);
  if (ma200) out.ma200  = parseFloat(ma200[1]);

  return out;
}

// ------------------------------------------------------------
//  BULL FLAG DETECTOR
// ------------------------------------------------------------
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

// ------------------------------------------------------------
//  UNIVERSAL DETECTORS
// ------------------------------------------------------------

// Even-number proximity (dynamic for small/big stocks)
export function detectEvenProximity(price) {
  if (!price) return null;

  let step = 0.05;
  if (price > 20) step = 0.5;
  if (price > 100) step = 1;
  if (price > 300) step = 5;
  if (price > 1000) step = 10;

  const nearest = Math.round(price / step) * step;
  const diff = price - nearest;

  return {
    nearest,
    diff,
    isNear: Math.abs(diff) <= step * 0.2,
    isJustAbove: diff > 0 && Math.abs(diff) <= step * 0.2,
    isJustBelow: diff < 0 && Math.abs(diff) <= step * 0.2
  };
}

// MA cluster / consolidation
export function detectMACluster({ maFast, maSlow, ma200, price }) {
  const arr = [maFast, maSlow, ma200].filter(v => v != null && !isNaN(v));
  if (arr.length < 2 || !price) return { clustered: false };

  const max = Math.max(...arr);
  const min = Math.min(...arr);
  const spread = max - min;

  return {
    clustered: spread <= price * 0.015,
    spread,
    max,
    min
  };
}

// MA slope / sharp move
export function detectMASlope(history) {
  if (!history || history.length < 3) return null;

  const last = history[history.length - 1];
  const prev = history[history.length - 2];

  const slopeFast = (last.maFast ?? 0) - (prev.maFast ?? 0);
  const slopeSlow = (last.maSlow ?? 0) - (prev.maSlow ?? 0);
  const slopePrice = (last.price ?? 0) - (prev.price ?? 0);

  return {
    slopeFast,
    slopeSlow,
    slopePrice,
    fastUp: slopeFast > 0,
    fastDown: slopeFast < 0,
    slowUp: slopeSlow > 0,
    slowDown: slopeSlow < 0,
    priceUp: slopePrice > 0,
    priceDown: slopePrice < 0,
    sharpMove: Math.abs(slopePrice) > (last.price ?? 0) * 0.01
  };
}

// Support / resistance via hit counts
export function detectSupportResistance(history, tolerance = 0.2) {
  if (!history || history.length === 0) return { supports: [], resistances: [] };

  const levels = {};

  history.forEach(c => {
    const p = c.price;
    if (!p && p !== 0) return;
    const key = Math.round(p / tolerance) * tolerance;
    if (!levels[key]) levels[key] = { level: key, hits: 0 };
    levels[key].hits++;
  });

  const arr = Object.values(levels);
  return {
    supports: arr.filter(l => l.hits >= 3),
    resistances: arr.filter(l => l.hits >= 3)
  };
}

// Breakout / breakdown
export function detectBreakout(price, supports, resistances) {
  if (!price) return null;
  let breakout = null;

  resistances.forEach(r => {
    if (price > r.level) breakout = { type: "breakout", level: r.level };
  });

  supports.forEach(s => {
    if (price < s.level) breakout = { type: "breakdown", level: s.level };
  });

  return breakout;
}

// Double top / bottom
export function detectDoubleTopBottom(history, tolerance = 0.3) {
  if (!history || history.length < 5) return { doubleTop: false, doubleBottom: false };

  const prices = history.map(c => c.price).filter(p => p != null);
  if (prices.length < 5) return { doubleTop: false, doubleBottom: false };

  const max = Math.max(...prices);
  const min = Math.min(...prices);

  const topHits = prices.filter(h => Math.abs(h - max) <= tolerance).length;
  const bottomHits = prices.filter(h => Math.abs(h - min) <= tolerance).length;

  return {
    doubleTop: topHits >= 2,
    doubleBottom: bottomHits >= 2,
    max,
    min
  };
}

// Rounding top / bottom
export function detectRounding(history) {
  if (!history || history.length < 10) {
    return { roundingBottom: false, roundingTop: false };
  }

  const prices = history.map(c => c.price).filter(p => p != null);
  if (prices.length < 10) return { roundingBottom: false, roundingTop: false };

  const mid = Math.floor(prices.length / 2);
  const left = prices[0];
  const center = prices[mid];
  const right = prices[prices.length - 1];

  return {
    roundingBottom: center < left && center < right,
    roundingTop: center > left && center > right
  };
}

// ------------------------------------------------------------
//  RULE SYSTEM
// ------------------------------------------------------------
const rules = [];
export function addRule(rule) { rules.push(rule); }

// ------------------------------------------------------------
//  DECISION ENGINE
// ------------------------------------------------------------
export function decideTrade(data, context = {}) {
  const notes = [];

  for (const rule of rules) {
    notes.push(`Checking rule: ${rule.name}`);
    const res = rule.check(data, notes, context);
    if (res) {
      notes.push(`Rule fired: ${rule.name}`);
      return { ...res, valid: true, notes };
    }
  }

  notes.push("No rule fired → no simple trade.");
  return {
    direction: "none",
    valid: false,
    entry: "",
    stop: "",
    target: "",
    wait: true,
    notes
  };
}

// ------------------------------------------------------------
//  FUTURE SIMULATION
// ------------------------------------------------------------
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

// ------------------------------------------------------------
//  ADVANCED OPTIONS PICKER
// ------------------------------------------------------------
export function pickOptionsContract(decision, daysToExpiry, underlying, ivHint = null) {
  if (!decision.valid) {
    return {
      directionText: "No clear trade.",
      summary: "The setup is not clean enough to choose a contract.",
      recommended: null,
      candidates: [],
      notes: [
        "No rule fired strongly enough to justify an options position.",
        "Wait for a cleaner alignment of price, MAs, and pattern."
      ]
    };
  }

  const dirText = decision.direction === "call"
    ? "CALL – expecting upside."
    : "PUT – expecting downside.";

  let expiryBucket = "";
  if (daysToExpiry <= 2) expiryBucket = "0DTE–2DTE scalp";
  else if (daysToExpiry <= 5) expiryBucket = "short‑term momentum";
  else if (daysToExpiry <= 10) expiryBucket = "swing for about a week";
  else if (daysToExpiry <= 20) expiryBucket = "1–3 week swing";
  else expiryBucket = "position trade";

  const entry = Number(decision.entry);
  const stop  = Number(decision.stop);
  const target = Number(decision.target);

  const riskPerShare = Math.abs(entry - stop);
  const rewardPerShare = Math.abs(target - entry);
  const rr = rewardPerShare > 0 ? (rewardPerShare / riskPerShare).toFixed(2) : "N/A";

  const strikes = [
    entry,
    decision.direction === "call" ? entry + 1 : entry - 1,
    decision.direction === "call" ? entry - 1 : entry + 1
  ].map(s => Math.round(s * 100) / 100);

  const candidates = strikes.map((strike, idx) => {
    const moneyness =
      decision.direction === "call"
        ? (strike < entry ? "ITM" : (strike === entry ? "ATM" : "OTM"))
        : (strike > entry ? "ITM" : (strike === entry ? "ATM" : "OTM"));

    const styleHint =
      idx === 0 ? "balanced risk/reward, clean alignment with entry" :
      idx === 1 ? "cheaper, higher leverage, more aggressive" :
                  "safer, more expensive, more forgiving";

    return {
      label: `${underlying} ${strike} ${decision.direction.toUpperCase()}`,
      strike,
      moneyness,
      styleHint
    };
  });

  let recommendedIndex = 0;
  if (daysToExpiry <= 2) recommendedIndex = 1;
  else if (daysToExpiry <= 10) recommendedIndex = 0;
  else recommendedIndex = 2;

  const recommended = candidates[recommendedIndex];

  const notes = [];
  notes.push(`Direction: ${dirText}`);
  notes.push(`Plan entry: ${entry.toFixed(2)}, stop: ${stop.toFixed(2)}, target: ${target.toFixed(2)}.`);
  notes.push(`Approx R:R on the underlying: ${rr}:1.`);
  notes.push(`Timeframe: ${expiryBucket}.`);

  if (ivHint) notes.push(`Implied volatility context: ${ivHint}.`);

  if (decision.wait) {
    notes.push("Price is stretched relative to the planned entry → WAIT for a better fill.");
  } else {
    notes.push("Price is close enough to the planned entry → OK to begin scaling in.");
  }

  notes.push("Use the underlying stop, not the option price, to manage risk.");

  return {
    directionText: dirText,
    summary: "Advanced contract guidance based on your golden rules and current setup.",
    recommended,
    candidates,
    notes
  };
}
