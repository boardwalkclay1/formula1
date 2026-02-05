// core.js

// ---------- BASIC HELPERS ----------
export function nearestEven(price) { return Math.round(price / 5) * 5; }
export function nextEvenUp(price)  { return Math.ceil(price / 5) * 5; }
export function nextEvenDown(p)    { return Math.floor(p / 5) * 5; }

// ---------- PARSE WEBULL / RIOT / AVGO TEXT ----------
export function parseChartText(raw) {
  let text = raw
    .replace(/\s+/g, ' ')
    .replace(/–|—/g, '-')                      // normalize dashes
    .replace(/[^0-9a-zA-Z\.\:\-\/ ]/g, '')     // strip weird OCR chars
    .replace(/(\d)\s+(\d)/g, '$1$2');          // fix digit spacing

  const out = {};

  // Ticker + price (RIOT / AVGO / generic)
  const priceMatch =
    text.match(/RIOT[^0-9]*([0-9]+\.[0-9]+)/i) ||
    text.match(/AVGO[^0-9]*([0-9]+\.[0-9]+)/i) ||
    text.match(/([0-9]+\.[0-9]+)\s*[▲▼\+\-]/);
  if (priceMatch) out.price = parseFloat(priceMatch[1]);

  // H/L 326.53-309.00
  const hlMatch = text.match(/H\/L[^0-9]*([0-9]+\.[0-9]+)-([0-9]+\.[0-9]+)/i);
  if (hlMatch) {
    out.dayHigh = parseFloat(hlMatch[1]);
    out.dayLow  = parseFloat(hlMatch[2]);
  }

  // MA(20,50,200) MA20:316.64 MA50:316.79 MA200:318.03
  const ma20 = text.match(/MA\(20\)[: ]*([0-9]+\.[0-9]+)/i) ||
               text.match(/MA20[: ]*([0-9]+\.[0-9]+)/i);
  const ma50 = text.match(/MA\(50\)[: ]*([0-9]+\.[0-9]+)/i) ||
               text.match(/MA50[: ]*([0-9]+\.[0-9]+)/i);
  const ma200 = text.match(/MA\(200\)[: ]*([0-9]+\.[0-9]+)/i) ||
                text.match(/MA200[: ]*([0-9]+\.[0-9]+)/i);

  if (ma20)  out.maFast = parseFloat(ma20[1]);
  if (ma50)  out.maSlow = parseFloat(ma50[1]);
  if (ma200) out.ma200  = parseFloat(ma200[1]);

  // Volume
  const vol = text.match(/Volume[^0-9]*([0-9]+\.[0-9]+)M/i);
  if (vol) out.volume = parseFloat(vol[1]) * 1_000_000;

  // Market Cap
  const mktCap = text.match(/Mkt Cap[^0-9]*([0-9]+\.[0-9]+)T/i) ||
                 text.match(/Mkt Cap[^0-9]*([0-9]+\.[0-9]+)B/i);
  if (mktCap) {
    const mult = mktCap[0].includes('T') ? 1_000_000_000_000 : 1_000_000_000;
    out.mktCap = parseFloat(mktCap[1]) * mult;
  }

  return out;
}

// ---------- BULLISH FLAG DETECTOR (GOLDEN PLAY) ----------
export function detectBullFlag(data) {
  const { price, dayHigh, dayLow, maFast, maSlow, ma200 } = data;

  if ([price, dayHigh, dayLow, maFast, maSlow].some(v => v == null || isNaN(v))) {
    return { isFlag: false, notes: [] };
  }

  const notes = [];

  // Price near high of day
  const range = dayHigh - dayLow;
  if (range <= 0) return { isFlag: false, notes };
  const pos = (price - dayLow) / range;
  if (pos < 0.6) return { isFlag: false, notes };
  notes.push("Price is holding in the upper part of today’s range.");

  // Above fast & slow MAs
  if (!(price > maFast && price > maSlow)) return { isFlag: false, notes };
  notes.push("Price is above both fast and slow moving averages.");

  // Fast & slow MAs tight
  const diffFS = Math.abs(maFast - maSlow);
  if (diffFS > price * 0.01) return { isFlag: false, notes };
  notes.push("Fast and slow MAs are almost on top of each other → tight flag.");

  // All MAs clustered
  if (!isNaN(ma200)) {
    const maxMA = Math.max(maFast, maSlow, ma200);
    const minMA = Math.min(maFast, maSlow, ma200);
    if ((maxMA - minMA) > price * 0.02) return { isFlag: false, notes };
    notes.push("20 / 50 / 200 MAs are clustered → strong trend.");
  }

  notes.push("This matches your golden bullish flag continuation pattern.");
  return { isFlag: true, notes };
}

// ---------- RULE SYSTEM (PLUGGABLE LOGIC) ----------
const rules = [];

// expose a way to add more rules later
export function addRule(rule) {
  rules.push(rule);
}

// 1) Bullish flag golden play (your golden setup)
addRule({
  name: "Bullish Flag Golden Play",
  check(data, notes) {
    const flag = detectBullFlag(data);
    if (!flag.isFlag) return null;

    notes.push(...flag.notes);
    notes.push("FLAG DETECTED → GOLDEN PLAY continuation setup.");

    const { price, dayHigh, dayLow } = data;
    const entry = nextEvenUp(price);
    const stop  = (entry * 0.8).toFixed(2);
    const range = (dayHigh && dayLow) ? (dayHigh - dayLow) : price * 0.03;
    const target = (dayHigh + range * 0.5 || price * 1.03).toFixed(2);

    const wait = price > entry * 1.02;
    if (wait) notes.push("Price is already stretched above the clean entry → better to wait for a pullback.");

    return {
      direction: "call",
      entry,
      stop,
      target,
      wait
    };
  }
});

// 2) Basic MA trend rule (fallback)
addRule({
  name: "Basic MA Trend",
  check(data, notes) {
    const { price, maFast, maSlow, ma200, dayHigh, dayLow } = data;
    if ([price, maFast, maSlow].some(v => v == null || isNaN(v))) {
      notes.push("Trend rule skipped: missing price or MAs.");
      return null;
    }

    let direction = "none";

    if (maFast > maSlow && price > maFast) {
      direction = "call";
      notes.push("Fast MA above slow MA and price above both → up move.");
    } else if (maFast < maSlow && price < maFast) {
      direction = "put";
      notes.push("Fast MA below slow MA and price below both → down move.");
    } else {
      notes.push("Trend rule: moving averages do not clearly show up or down.");
      return null;
    }

    if (!isNaN(ma200)) {
      if (maFast > maSlow && maFast > ma200) notes.push("Golden cross style uptrend.");
      if (maFast < maSlow && maFast < ma200) notes.push("Death cross style downtrend.");
    }

    let entry, stop, target, wait = false;

    if (direction === "call") {
      entry = nextEvenUp(price);
      stop  = (entry * 0.8).toFixed(2);
      const range = (dayHigh && dayLow) ? (dayHigh - dayLow) : price * 0.03;
      target = (price + range).toFixed(2);
      if (price > entry * 1.02) {
        wait = true;
        notes.push("Price is already stretched above the clean entry → better to wait for a pullback.");
      }
    } else {
      entry = nextEvenDown(price);
      stop  = (entry * 1.2).toFixed(2);
      const range = (dayHigh && dayLow) ? (dayHigh - dayLow) : price * 0.03;
      target = (price - range).toFixed(2);
      if (price < entry * 0.98) {
        wait = true;
        notes.push("Price is already stretched below the clean entry → better to wait for a bounce.");
      }
    }

    return { direction, entry, stop, target, wait };
  }
});

// ---------- GOLDEN DECISION ENGINE (USES RULES) ----------
export function decideTrade(data) {
  const notes = [];

  if ([data.price, data.maFast, data.maSlow].some(v => v == null || isNaN(v))) {
    notes.push("Could not read price and moving averages clearly.");
    return { direction: "none", valid: false, entry: "", stop: "", target: "", wait: true, notes };
  }

  for (const rule of rules) {
    notes.push(`Checking rule: ${rule.name}`);
    const res = rule.check(data, notes);
    if (res) {
      notes.push(`Rule fired: ${rule.name}`);
      return {
        direction: res.direction,
        valid: true,
        entry: res.entry,
        stop: res.stop,
        target: res.target,
        wait: !!res.wait,
        notes
      };
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

// ---------- SIMPLE FUTURE SIMULATION ----------
export function simulateFuture(data, decision) {
  const { price } = data;
  const candles = [];
  const steps = 30;

  if (!decision.valid || decision.direction === "none") {
    for (let i = 0; i < steps; i++) {
      const drift = (Math.random() - 0.5) * (price * 0.002);
      candles.push(price + drift);
    }
    return candles;
  }

  let current = price;
  const bias = decision.direction === "call" ? 1 : -1;

  for (let i = 0; i < steps; i++) {
    const trend = bias * price * 0.003;
    const noise = (Math.random() - 0.5) * (price * 0.001);
    current = current + trend + noise;
    candles.push(current);
  }
  return candles;
}

// ---------- OPTIONS CONTRACT PICKER ----------
export function pickOptionsContract(decision, daysToExpiry) {
  if (!decision.valid || decision.direction === "none") {
    return {
      directionText: "No clear trade.",
      summary: "The setup is not clean enough to choose a contract.",
      details: []
    };
  }

  const dirText = decision.direction === "call"
    ? "CALL – you are betting price will go up from the entry."
    : "PUT – you are betting price will go down from the entry.";

  let expiryText = "";
  if (daysToExpiry <= 2) expiryText = "very short‑term scalp (1–2 days).";
  else if (daysToExpiry <= 5) expiryText = "short‑term move (3–5 days).";
  else if (daysToExpiry <= 10) expiryText = "about a week or so.";
  else if (daysToExpiry <= 20) expiryText = "a couple of weeks.";
  else expiryText = "a swing over about a month.";

  const details = [
    `Direction: ${dirText}`,
    `Use a strike near the even‑number entry: around ${decision.entry}.`,
    `Place your stop where the plan breaks: about ${decision.stop}.`,
    `Aim for the target zone: around ${decision.target}.`,
    `Pick an expiration that matches how long you expect the move to take: ${expiryText}`
  ];

  if (decision.wait) {
    details.push("Price is already stretched away from the ideal entry → better to WAIT for price to come back to your level.");
  } else {
    details.push("Price is close enough to the ideal entry → you can consider entering now if the plan still makes sense.");
  }

  return {
    directionText: dirText,
    summary: "This is the basic contract idea based on your golden rules.",
    details
  };
}
