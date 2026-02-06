// modules/ticker.js
// Advanced ticker helper: Finnhub lookup, chart render, caching, and UI injection.
// Exports: lookupTicker(symbol), renderLookupCanvas(candles, meta, canvas), saveCanvasBlob(canvas), sendCanvasToSimulator(canvas, simulatorCallback)

const FINNHUB_API_KEY = 'd5jjkq1r01qgsosgmj9gd5jjkq1r01qgsosgmja0'; // embedded per request

async function finnhubFetch(path, params = {}) {
  const url = new URL(`https://finnhub.io/api/v1/${path}`);
  url.searchParams.set('token', FINNHUB_API_KEY);
  Object.entries(params).forEach(([k, v]) => { if (v != null) url.searchParams.set(k, v); });
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Finnhub ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function lookupTicker(symbol) {
  symbol = (symbol || '').trim().toUpperCase();
  if (!symbol) throw new Error('Ticker required');
  const profile = await finnhubFetch('stock/profile2', { symbol });
  const quote = await finnhubFetch('quote', { symbol });
  const now = Math.floor(Date.now() / 1000);
  const from = now - 60 * 60 * 24 * 60; // ~60 days
  const candles = await finnhubFetch('stock/candle', { symbol, resolution: 'D', from, to: now });
  return { profile, quote, candles };
}

export function renderLookupCanvas(candles, meta = {}, canvas) {
  if (!canvas) throw new Error('Canvas required');
  const ctx = canvas.getContext('2d');
  const cssW = canvas.width || canvas.clientWidth;
  const cssH = canvas.height || canvas.clientHeight;
  canvas.width = cssW;
  canvas.height = cssH;
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, cssW, cssH);

  if (!candles || candles.s !== 'ok' || !candles.c || candles.c.length === 0) {
    ctx.fillStyle = '#cfcfcf';
    ctx.font = '14px system-ui, Arial';
    ctx.fillText('No candle data available', 12, 24);
    return;
  }

  const o = candles.o, h = candles.h, l = candles.l, c = candles.c;
  const len = c.length;
  const pad = 36;
  const chartW = cssW - pad * 2;
  const chartH = cssH - pad * 2;
  const maxP = Math.max(...h);
  const minP = Math.min(...l);

  function yFor(price) {
    if (maxP === minP) return pad + chartH / 2;
    return pad + ((maxP - price) / (maxP - minP)) * chartH;
  }

  ctx.strokeStyle = 'rgba(212,175,55,0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + (i / 4) * chartH;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(pad + chartW, y);
    ctx.stroke();
  }

  const candleW = Math.max(2, Math.floor(chartW / len * 0.7));
  for (let i = 0; i < len; i++) {
    const x = pad + (i / len) * chartW + (chartW / len - candleW) / 2;
    const open = o[i], high = h[i], low = l[i], close = c[i];
    const yOpen = yFor(open), yClose = yFor(close), yHigh = yFor(high), yLow = yFor(low);
    const bodyTop = Math.min(yOpen, yClose), bodyBottom = Math.max(yOpen, yClose);
    const isBull = close >= open;

    ctx.strokeStyle = isBull ? '#3cff9d' : '#ff4b4b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + candleW / 2, yHigh);
    ctx.lineTo(x + candleW / 2, yLow);
    ctx.stroke();

    ctx.fillStyle = isBull ? 'rgba(60,255,157,0.18)' : 'rgba(255,75,75,0.18)';
    ctx.fillRect(x, bodyTop, candleW, Math.max(1, bodyBottom - bodyTop));
    ctx.strokeStyle = isBull ? '#3cff9d' : '#ff4b4b';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, bodyTop + 0.5, candleW - 1, Math.max(1, bodyBottom - bodyTop) - 1);
  }

  ctx.fillStyle = '#d4af37';
  ctx.font = '12px system-ui, Arial';
  ctx.fillText(`High ${maxP.toFixed(2)}`, pad + 6, pad + 12);
  ctx.fillText(`Low ${minP.toFixed(2)}`, pad + 6, pad + chartH - 6);

  const metaText = `${meta.symbol || ''} ${meta.name ? '• ' + meta.name : ''}  |  Price: ${meta.price != null ? meta.price.toFixed(2) : 'n/a'}`;
  ctx.fillStyle = '#cfcfcf';
  ctx.font = '12px system-ui, Arial';
  ctx.fillText(metaText, pad, cssH - 8);
}

export function saveCanvasBlob(canvas, filename = `chart-${Date.now()}.png`) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) return resolve(null);
      downloadBlob(blob, filename);
      resolve(blob);
    }, 'image/png');
  });
}

export async function sendCanvasToSimulator(canvas, simulatorCallback) {
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Could not create blob from canvas');
  const file = new File([blob], `lookup-${Date.now()}.png`, { type: 'image/png' });
  return simulatorCallback(file);
}
