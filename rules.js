// rules.js

import {
  addRule,
  nextEvenUp,
  nextEvenDown,
  detectBullFlag,
  detectEvenProximity,
  detectMACluster,
  detectDoubleTopBottom,
  detectRounding
} from "./core.js";

// context: { history, supports, resistances, breakout, slopes, patterns }

// ---------- RULE 1: Bullish Flag Golden Play ----------
addRule({
  name: "Bullish Flag Golden Play",
  check(data, notes, context = {}) {
    const flag = detectBullFlag(data);
    if (!flag.isFlag) return null;

    notes.push(...flag.notes);

    const even = detectEvenProximity(data.price);
    if (even?.isJustBelow) {
      notes.push(`Price is just below key even level ${even.nearest} → breakout fuel.`);
    }

    const cluster = detectMACluster(data);
    if (cluster.clustered) {
      notes.push("MAs are tightly clustered → strong consolidation before move.");
    }

    const { price, dayHigh, dayLow } = data;
    const entry = nextEvenUp(price);
    const stop  = (entry * 0.8).toFixed(2);
    const range = (dayHigh && dayLow) ? (dayHigh - dayLow) : price * 0.03;
    const target = (dayHigh + range * 0.5).toFixed(2);

    const wait = price > entry * 1.02;

    return { direction: "call", entry, stop, target, wait };
  }
});

// ---------- RULE 2: Basic MA Trend ----------
addRule({
  name: "Basic MA Trend",
  check(data, notes, context = {}) {
    const { price, maFast, maSlow, dayHigh, dayLow } = data;
    if ([price, maFast, maSlow].some(v => v == null || isNaN(v))) return null;

    let direction = "none";
    if (maFast > maSlow && price > maFast) {
      direction = "call";
      notes.push("Fast MA above slow MA and price above fast MA → uptrend.");
    }
    if (maFast < maSlow && price < maFast) {
      direction = "put";
      notes.push("Fast MA below slow MA and price below fast MA → downtrend.");
    }
    if (direction === "none") return null;

    const even = detectEvenProximity(price);
    if (even?.isNear) {
      notes.push(`Price is near even level ${even.nearest} → psychological level in play.`);
    }

    const cluster = detectMACluster(data);
    if (cluster.clustered) {
      notes.push("MAs are clustered → consolidation inside trend.");
    }

    let entry, stop, target, wait = false;
    const range = (dayHigh && dayLow) ? (dayHigh - dayLow) : price * 0.03;

    if (direction === "call") {
      entry = nextEvenUp(price);
      stop = (entry * 0.8).toFixed(2);
      target = (price + range).toFixed(2);
      wait = price > entry * 1.02;
    } else {
      entry = nextEvenDown(price);
      stop = (entry * 1.2).toFixed(2);
      target = (price - range).toFixed(2);
      wait = price < entry * 0.98;
    }

    return { direction, entry, stop, target, wait };
  }
});

// ---------- RULE 3: Even Number Breakout with MA Cluster ----------
addRule({
  name: "Even Number Breakout + MA Cluster",
  check(data, notes, context = {}) {
    const { price, dayHigh, dayLow } = data;
    if (!price) return null;

    const even = detectEvenProximity(price);
    if (!even || !even.isJustBelow) return null;

    const cluster = detectMACluster(data);
    if (!cluster.clustered) return null;

    notes.push(`Price is sitting just below even level ${even.nearest}.`);
    notes.push("MAs are tightly clustered → coiled spring setup.");

    const entry = even.nearest + 0.05;
    const stop  = (entry * 0.8).toFixed(2);
    const range = (dayHigh && dayLow) ? (dayHigh - dayLow) : price * 0.03;
    const target = (entry + range).toFixed(2);

    return { direction: "call", entry, stop, target, wait: false };
  }
});

// ---------- RULE 4: Double Top / Double Bottom Reversal ----------
addRule({
  name: "Double Top / Bottom Reversal",
  check(data, notes, context = {}) {
    const { history } = context;
    if (!history || history.length < 5) return null;

    const pattern = detectDoubleTopBottom(history);
    const price = data.price;
    if (!price) return null;

    if (pattern.doubleTop) {
      notes.push("Double top detected near recent highs → potential reversal down.");
      const entry = nextEvenDown(price);
      const stop  = (entry * 1.2).toFixed(2);
      const target = (price - (price * 0.03)).toFixed(2);
      return { direction: "put", entry, stop, target, wait: false };
    }

    if (pattern.doubleBottom) {
      notes.push("Double bottom detected near recent lows → potential reversal up.");
      const entry = nextEvenUp(price);
      const stop  = (entry * 0.8).toFixed(2);
      const target = (price + (price * 0.03)).toFixed(2);
      return { direction: "call", entry, stop, target, wait: false };
    }

    return null;
  }
});

// ---------- RULE 5: Rounding Bottom / Top Swing ----------
addRule({
  name: "Rounding Bottom / Top Swing",
  check(data, notes, context = {}) {
    const { history } = context;
    if (!history || history.length < 10) return null;

    const rounding = detectRounding(history);
    const price = data.price;
    if (!price) return null;

    if (rounding.roundingBottom) {
      notes.push("Rounding bottom pattern detected → accumulation then push higher.");
      const entry = nextEvenUp(price);
      const stop  = (entry * 0.85).toFixed(2);
      const target = (price + price * 0.05).toFixed(2);
      return { direction: "call", entry, stop, target, wait: false };
    }

    if (rounding.roundingTop) {
      notes.push("Rounding top pattern detected → distribution then drop.");
      const entry = nextEvenDown(price);
      const stop  = (entry * 1.15).toFixed(2);
      const target = (price - price * 0.05).toFixed(2);
      return { direction: "put", entry, stop, target, wait: false };
    }

    return null;
  }
});
