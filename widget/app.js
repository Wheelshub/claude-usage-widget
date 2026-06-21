'use strict';

/* data endpoint — same-origin when served by the collector, else localhost */
var ENDPOINT =
  window.CLAUDE_USAGE_ENDPOINT ||
  (location.protocol.indexOf('http') === 0 ? './usage.json' : 'http://127.0.0.1:8787/usage.json');

var POLL_MS = 30000;
var R = 80, SW = 18, CIRC = 2 * Math.PI * R;
var WIN_5H = 5 * 3600 * 1000;
var WIN_WK = 7 * 24 * 3600 * 1000;

var app = document.getElementById('app');
var gaugesEl = document.getElementById('gauges');
var panelEl = document.getElementById('panel');
var bannerEl = document.getElementById('banner');
var planEl = document.getElementById('plan');
var sourceEl = document.getElementById('source');
var updatedEl = document.getElementById('updated');
var dateEl = document.getElementById('date');
var clockEl = document.getElementById('clock');
var statusEl = document.getElementById('statusline');

var latest = null;

/* ---------- formatting ---------- */
function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtCost(n) { return n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: n < 100 ? 2 : 0 }); }
function fmtPct(n) { return n == null ? null : (n >= 99.5 ? '100' : (n < 10 ? n.toFixed(1) : String(Math.round(n)))); }
function pad(n) { return String(n).padStart(2, '0'); }

function countdown(iso) {
  if (!iso) return null;
  var ms = new Date(iso).getTime() - Date.now();
  if (isNaN(ms)) return null;
  if (ms <= 0) return 'now';
  var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm ' + sec + 's';
}
function resetAtLabel(iso, weekly) {
  if (!iso) return '';
  var dt = new Date(iso);
  if (isNaN(dt)) return '';
  var t = pad(dt.getHours()) + ':' + pad(dt.getMinutes());
  if (weekly) {
    var day = dt.toLocaleDateString(undefined, { weekday: 'short' });
    return day + ' ' + t;
  }
  return t;
}
function colorFor(p) { return p == null ? 'var(--accent)' : p >= 90 ? 'var(--crit)' : p >= 75 ? 'var(--warn)' : 'var(--accent)'; }

/* ---------- gauge row ---------- */
function gaugeRow(w, opts) {
  opts = opts || {};
  var row = document.createElement('div');
  row.className = 'grow';

  var p = w && w.utilization != null ? w.utilization : null;
  var pct = fmtPct(p);
  var offset = p == null ? CIRC : CIRC * (1 - Math.min(100, p) / 100);
  var stroke = colorFor(p);

  // ring center
  var center = pct != null
    ? '<span class="pct">' + pct + '<span class="u">%</span></span>'
    : '<span class="pct" style="font-size:clamp(18px,4.6vh,40px)">' + fmtTokens(w && w.usedTokens) + '</span>';
  var centerSub = pct == null && w && w.usedTokens != null ? '<span class="gc-sub">tokens</span>' : '';

  // used / limit line
  var usedLine = '';
  if (w && w.usedTokens != null) {
    usedLine = '<div class="gline"><b>' + fmtTokens(w.usedTokens) + '</b>' +
      (w.limitTokens ? ' / ' + fmtTokens(w.limitTokens) : '') + ' tokens</div>';
  } else if (opts.extraLine) {
    usedLine = '<div class="gline">' + opts.extraLine + '</div>';
  }

  // reset line
  var cd = w ? countdown(w.resetsAt) : null;
  var resetLine = cd
    ? '<div class="greset"><span class="lab">resets in </span><b data-reset="' + (w.resetsAt || '') + '">' + cd + '</b>' +
      (w.resetsAt ? ' <span class="at">@ ' + resetAtLabel(w.resetsAt, opts.weekly) + '</span>' : '') + '</div>'
    : '<div class="greset"><span class="lab">' + (w && w.estimated ? 'rolling window' : 'no reset data') + '</span></div>';

  // pace bar (time elapsed in window)
  var pace = '';
  if (w && w.resetsAt && opts.windowMs) {
    var end = new Date(w.resetsAt).getTime();
    var start = end - opts.windowMs;
    var frac = Math.max(0, Math.min(1, (Date.now() - start) / opts.windowMs));
    pace = '<div class="pace" data-win="' + opts.windowMs + '" data-reset="' + w.resetsAt + '"><i style="width:' + (frac * 100).toFixed(1) + '%"></i></div>' +
      '<div class="gpace-lab">' + Math.round(frac * 100) + '% of window elapsed</div>';
  }

  row.innerHTML =
    '<div class="gauge"><svg viewBox="0 0 200 200">' +
    '<circle class="track" cx="100" cy="100" r="' + R + '" fill="none" stroke-width="' + SW + '"/>' +
    '<circle class="value" cx="100" cy="100" r="' + R + '" fill="none" stroke-width="' + SW + '" ' +
    'stroke-dasharray="' + CIRC.toFixed(1) + '" stroke-dashoffset="' + offset.toFixed(1) + '" style="stroke:' + stroke + '"/>' +
    '</svg><div class="gc">' + center + centerSub + '</div></div>' +
    '<div class="ginfo">' +
    '<div class="glabel">' + opts.label + '</div>' +
    usedLine + resetLine + pace +
    '</div>';
  return row;
}

/* ---------- stat cell ---------- */
function cell(val, key, sub) {
  return '<div class="cell"><span class="cv">' + val + '</span><span class="ck">' + key + '</span>' +
    (sub ? '<span class="cs">' + sub + '</span>' : '') + '</div>';
}

/* ---------- render ---------- */
function render(d) {
  latest = d;

  if (!d || d.ok === false) {
    app.setAttribute('data-state', 'error');
    bannerEl.hidden = false;
    bannerEl.textContent = '⚠ ' + ((d && d.error) || 'Collector unreachable.');
  } else {
    app.setAttribute('data-state', 'ready');
    if (d.warnings && d.warnings.length) { bannerEl.hidden = false; bannerEl.textContent = d.warnings.join('  ·  '); }
    else bannerEl.hidden = true;
  }

  planEl.textContent = d && d.plan ? d.plan : '';
  planEl.style.display = d && d.plan ? '' : 'none';
  if (d && d.source) { sourceEl.textContent = d.source === 'official' ? 'OFFICIAL' : 'ESTIMATED'; sourceEl.setAttribute('data-source', d.source); }
  else sourceEl.textContent = '';
  if (d && d.generatedAt) {
    var g = new Date(d.generatedAt);
    updatedEl.textContent = 'updated ' + pad(g.getHours()) + ':' + pad(g.getMinutes()) + ':' + pad(g.getSeconds());
  }

  // gauges (stacked)
  gaugesEl.innerHTML = '';
  if (d && d.ok !== false) {
    // weekly per-model extra line
    var wkExtra = '';
    if (d.weeklySonnet && d.weeklySonnet.utilization != null) wkExtra += 'Sonnet ' + fmtPct(d.weeklySonnet.utilization) + '%';
    if (d.weeklyOpus && d.weeklyOpus.utilization != null) wkExtra += (wkExtra ? ' · ' : '') + 'Opus ' + fmtPct(d.weeklyOpus.utilization) + '%';

    gaugesEl.appendChild(gaugeRow(d.fiveHour, { label: '5-HOUR SESSION', windowMs: WIN_5H }));
    gaugesEl.appendChild(gaugeRow(d.weekly, { label: 'WEEKLY LIMIT', weekly: true, windowMs: WIN_WK, extraLine: wkExtra }));
  }

  // packed stats
  panelEl.innerHTML = '';
  if (d && d.ok !== false) {
    var t = d.tokens || {}, c = d.cost || {}, b = d.burnRate || {}, bl = d.block || {};
    var cacheReadPct = t.total ? Math.round((t.cacheRead / t.total) * 100) : null;
    var html = '';
    html += cell(fmtTokens(t.total), 'Tokens', 'in ' + fmtTokens(t.input) + ' · out ' + fmtTokens(t.output));
    html += cell(fmtTokens(t.cacheRead), 'Cache read', cacheReadPct != null ? cacheReadPct + '% of all' : '');
    html += cell(fmtCost(c.week), 'Cost · 7d', c.session != null ? 'block ' + fmtCost(c.session) : '');
    html += cell(fmtCost(c.total), 'Cost · all', '');
    html += cell(b.tokensPerMin ? fmtTokens(b.tokensPerMin) + '/m' : '—', 'Burn rate', b.costPerHour ? fmtCost(b.costPerHour) + '/hr' : '');
    html += cell(fmtTokens(bl.projectedTotalTokens), 'Block proj.', bl.projectedCost != null ? '≈ ' + fmtCost(bl.projectedCost) : '');
    html += cell(bl.endsAt ? resetAtLabel(bl.endsAt) : '—', 'Block ends', bl.startsAt ? resetAtLabel(bl.startsAt) + '→' : '');
    var sonnet = d.weeklySonnet && d.weeklySonnet.utilization != null ? fmtPct(d.weeklySonnet.utilization) + '%' : '—';
    html += cell(sonnet, 'Wk · Sonnet', d.weeklyOpus && d.weeklyOpus.utilization != null ? 'Opus ' + fmtPct(d.weeklyOpus.utilization) + '%' : '');
    panelEl.innerHTML = html;
  }

  // status line
  if (d) {
    var prov = d.provider || '—';
    statusEl.innerHTML =
      '<span class="chev">⏵</span> <span class="seg">usage</span>' +
      ' · <span class="seg">src <b>' + prov + '</b></span>' +
      ' · <span class="seg">5h <b>' + (d.fiveHour && d.fiveHour.utilization != null ? fmtPct(d.fiveHour.utilization) + '%' : '—') + '</b></span>' +
      ' · <span class="seg">wk <b>' + (d.weekly && d.weekly.utilization != null ? fmtPct(d.weekly.utilization) + '%' : '—') + '</b></span>' +
      ' · <span class="seg">↻ ' + Math.round(POLL_MS / 1000) + 's</span>' +
      '<span class="cursor"></span>';
  }
}

/* ---------- live clock + countdown ticks ---------- */
function tick() {
  var now = new Date();
  var dow = now.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase();
  var rest = now.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
  dateEl.innerHTML = '<span class="dow">' + dow + '</span>&nbsp;&nbsp;' + rest;
  clockEl.innerHTML = pad(now.getHours()) + ':' + pad(now.getMinutes()) + '<span class="sec">:' + pad(now.getSeconds()) + '</span>';

  var nodes = document.querySelectorAll('[data-reset]');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i], iso = el.getAttribute('data-reset');
    if (el.classList.contains('pace')) {
      var win = +el.getAttribute('data-win'), end = new Date(iso).getTime(), start = end - win;
      var frac = Math.max(0, Math.min(1, (Date.now() - start) / win));
      var bar = el.firstChild; if (bar) bar.style.width = (frac * 100).toFixed(1) + '%';
    } else {
      var c = countdown(iso); if (c) el.textContent = c;
    }
  }
}

function poll() {
  fetch(ENDPOINT, { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) { app.classList.remove('stale'); render(d); })
    .catch(function (e) { app.classList.add('stale'); if (!latest) render({ ok: false, error: 'Cannot reach ' + ENDPOINT }); });
}

tick();
poll();
setInterval(poll, POLL_MS);
setInterval(tick, 1000);
