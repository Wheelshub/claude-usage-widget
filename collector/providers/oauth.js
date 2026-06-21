'use strict';

const { resolveToken } = require('../lib/credentials');
const ccusage = require('./ccusage');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function win(node, label) {
  if (!node || typeof node !== 'object') return null;
  const util = typeof node.utilization === 'number' ? node.utilization : null;
  return {
    utilization: util, // already 0-100 from the endpoint
    resetsAt: node.resets_at || node.resetsAt || null,
    label,
    estimated: false,
  };
}

/**
 * Build a normalized usage object from Anthropic's official /api/oauth/usage.
 * Optionally supplements token/cost totals from ccusage.
 */
async function collect(config) {
  const out = {
    source: 'official',
    fiveHour: null,
    weekly: null,
    weeklyOpus: null,
    weeklySonnet: null,
    tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
    cost: { session: null, today: null, week: null, total: null },
    burnRate: { tokensPerMin: null, costPerHour: null },
    block: { startsAt: null, endsAt: null, projectedTotalTokens: null, projectedCost: null },
    extraUsage: null,
    warnings: [],
  };

  const { token, from, error } = resolveToken(config);
  if (!token) {
    throw new Error(`No OAuth token (${error || 'unknown'}). Looked at: ${from}`);
  }

  const version = (config.oauth && config.oauth.userAgentVersion) || '1.0.80';

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20_000);
  let res;
  try {
    res = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `claude-code/${version}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(t);
  }

  if (res.status === 401) {
    throw new Error('401 Unauthorized — token expired. Run any Claude Code command to refresh it.');
  }
  if (res.status === 429) {
    const ra = res.headers.get('retry-after');
    throw new Error(`429 rate limited (retry-after: ${ra}). Increase refreshSeconds (>=180).`);
  }
  if (!res.ok) {
    throw new Error(`/api/oauth/usage returned HTTP ${res.status}`);
  }

  const data = await res.json();

  out.fiveHour = win(data.five_hour, '5-hour session');
  out.weekly = win(data.seven_day, 'Weekly (all models)');
  out.weeklyOpus = win(data.seven_day_opus, 'Weekly (Opus)');
  out.weeklySonnet = win(data.seven_day_sonnet, 'Weekly (Sonnet)');

  if (data.extra_usage && data.extra_usage.is_enabled) {
    out.extraUsage = {
      monthlyLimit: data.extra_usage.monthly_limit ?? null,
      usedCredits: data.extra_usage.used_credits ?? null,
      utilization: data.extra_usage.utilization ?? null,
    };
  }

  // Supplement with local token/cost detail (the endpoint only gives % + resets).
  if (config.oauth && config.oauth.supplementWithCcusage !== false) {
    try {
      const cc = await ccusage.collect(config);
      out.tokens = cc.tokens;
      out.cost = cc.cost;
      out.burnRate = cc.burnRate;
      out.block = cc.block;
      if (cc.warnings && cc.warnings.length) {
        out.warnings.push(...cc.warnings.map((w) => `ccusage ${w}`));
      }
    } catch (e) {
      out.warnings.push(`ccusage supplement failed: ${e.message}`);
    }
  }

  return out;
}

module.exports = { collect };
