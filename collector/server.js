'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

let config = loadConfig();
const providers = {
  ccusage: require('./providers/ccusage'),
  oauth: require('./providers/oauth'),
};

// Latest normalized snapshot served to the widget.
let snapshot = {
  ok: false,
  provider: config.provider,
  generatedAt: null,
  error: 'Collecting first sample…',
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function refresh() {
  const providerName = config.provider === 'oauth' ? 'oauth' : 'ccusage';
  const provider = providers[providerName];
  try {
    const data = await provider.collect(config);
    snapshot = {
      ok: true,
      provider: providerName,
      plan: config.plan && config.plan.name ? config.plan.name : null,
      generatedAt: new Date().toISOString(),
      error: null,
      ...data,
    };
    log(
      `ok (${providerName}/${data.source}) ` +
        `5h=${fmtPct(data.fiveHour)} weekly=${fmtPct(data.weekly)}` +
        (data.warnings && data.warnings.length ? ` warnings=${data.warnings.length}` : '')
    );
  } catch (err) {
    snapshot = {
      ok: false,
      provider: providerName,
      generatedAt: new Date().toISOString(),
      error: err.message,
      // keep last good rings if we had them
      fiveHour: snapshot.fiveHour || null,
      weekly: snapshot.weekly || null,
    };
    log(`ERROR (${providerName}): ${err.message}`);
  }

  // Persist last snapshot for debugging / cold-start.
  try {
    fs.writeFileSync(path.join(__dirname, 'usage.json'), JSON.stringify(snapshot, null, 2));
  } catch {
    /* ignore */
  }
}

function fmtPct(w) {
  if (!w || w.utilization == null) return 'n/a';
  return `${w.utilization.toFixed(1)}%`;
}

// ---- static widget serving ----------------------------------------------

const WIDGET_DIR = path.join(__dirname, '..', 'widget');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel).replace(/\.\.+/g, ''); // basic traversal guard
  const file = path.join(WIDGET_DIR, rel);
  if (!file.startsWith(WIDGET_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  // CORS so a packaged (file://) widget can fetch us cross-origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const urlPath = (req.url || '/').split('?')[0];

  if (urlPath === '/usage.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(snapshot));
    return;
  }
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: snapshot.ok, provider: snapshot.provider, generatedAt: snapshot.generatedAt }));
    return;
  }

  serveStatic(req, res, urlPath);
});

const PORT = config.port || 8787;
server.listen(PORT, '127.0.0.1', () => {
  log(`Claude usage collector listening on http://127.0.0.1:${PORT}`);
  log(`  data:   http://127.0.0.1:${PORT}/usage.json`);
  log(`  widget: http://127.0.0.1:${PORT}/   (use this URL in an iCUE iFrame widget)`);
  log(`  provider=${config.provider}  refresh=${config.refreshSeconds || 180}s`);
  refresh();
  const everyMs = Math.max(30, config.refreshSeconds || 180) * 1000;
  setInterval(refresh, everyMs);
});
