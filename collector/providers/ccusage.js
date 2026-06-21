'use strict';

const { execFile } = require('child_process');

// ---- small helpers -------------------------------------------------------

function num(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

// Pick the first present key from a list (ccusage field names drift between versions).
function pick(obj, keys, dflt) {
  if (!obj) return dflt;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return dflt;
}

function runCcusage(config, extraArgs) {
  const cc = config.ccusage || {};
  const runner = cc.runner || 'npx';
  const baseArgs = cc.runnerArgs || ['-y', 'ccusage@latest'];
  const args = [...baseArgs, ...extraArgs];

  return new Promise((resolve, reject) => {
    execFile(
      runner,
      args,
      {
        shell: process.platform === 'win32', // resolve npx.cmd on Windows
        windowsHide: true,
        timeout: 90_000,
        maxBuffer: 32 * 1024 * 1024,
        env: process.env,
      },
      (err, stdout) => {
        if (err && !stdout) return reject(err);
        try {
          // ccusage may print a notice line before JSON; grab the JSON body.
          const text = String(stdout);
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          if (start === -1 || end === -1) throw new Error('no JSON in ccusage output');
          resolve(JSON.parse(text.slice(start, end + 1)));
        } catch (e) {
          reject(new Error(`ccusage JSON parse failed: ${e.message}`));
        }
      }
    );
  });
}

function tokenCounts(node) {
  const tc = node.tokenCounts || node.tokens || node || {};
  const input = num(pick(node, ['inputTokens', 'input']) ?? pick(tc, ['inputTokens', 'input']));
  const output = num(pick(node, ['outputTokens', 'output']) ?? pick(tc, ['outputTokens', 'output']));
  const cacheCreate = num(
    pick(node, ['cacheCreationTokens', 'cacheCreationInputTokens']) ??
      pick(tc, ['cacheCreationInputTokens', 'cacheCreationTokens'])
  );
  const cacheRead = num(
    pick(node, ['cacheReadTokens', 'cacheReadInputTokens']) ??
      pick(tc, ['cacheReadInputTokens', 'cacheReadTokens'])
  );
  const total = num(pick(node, ['totalTokens', 'total'], input + output + cacheCreate + cacheRead));
  return { input, output, cacheCreate, cacheRead, total };
}

// ---- main ----------------------------------------------------------------

/**
 * Build a normalized usage object purely from local ccusage data.
 * Percentages here are ESTIMATES against a token budget, not Anthropic's
 * official utilization.
 */
async function collect(config) {
  const out = {
    source: 'estimated',
    fiveHour: null,
    weekly: null,
    weeklyOpus: null,
    weeklySonnet: null,
    tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
    cost: { session: null, today: null, week: null, total: null },
    burnRate: { tokensPerMin: null, costPerHour: null },
    block: { startsAt: null, endsAt: null, projectedTotalTokens: null, projectedCost: null },
    warnings: [],
  };

  // --- active 5-hour block ---
  let blocks = null;
  try {
    const data = await runCcusage(config, ['blocks', '--json']);
    blocks = data.blocks || data.data || [];
  } catch (e) {
    out.warnings.push(`blocks: ${e.message}`);
  }

  if (blocks && blocks.length) {
    const active = blocks.find((b) => b.isActive) || null;

    // Largest previous real block -> default 5h denominator.
    const prevMax = blocks
      .filter((b) => !b.isGap)
      .reduce((m, b) => Math.max(m, num(pick(b, ['totalTokens', 'total']))), 0);

    if (active) {
      const tc = tokenCounts(active);
      const startsAt = pick(active, ['startTime', 'blockStart', 'startsAt']);
      const endsAt = pick(active, ['endTime', 'blockEnd', 'endsAt']);
      const burn = active.burnRate || {};
      const proj = active.projection || {};

      const limit =
        num(config?.plan?.blockTokenLimit) > 0 ? num(config.plan.blockTokenLimit) : prevMax;

      out.fiveHour = {
        utilization: limit > 0 ? Math.min(100, (tc.total / limit) * 100) : null,
        resetsAt: endsAt || null,
        usedTokens: tc.total,
        limitTokens: limit > 0 ? limit : null,
        label: '5-hour session',
        estimated: true,
      };
      out.block = {
        startsAt: startsAt || null,
        endsAt: endsAt || null,
        projectedTotalTokens: num(pick(proj, ['totalTokens', 'total'])) || null,
        projectedCost: num(pick(proj, ['totalCost', 'cost'])) || null,
      };
      out.burnRate = {
        tokensPerMin: num(pick(burn, ['tokensPerMinute', 'tokensPerMin'])) || null,
        costPerHour: num(pick(burn, ['costPerHour', 'costPerHourUSD'])) || null,
      };
      out.cost.session = num(pick(active, ['costUSD', 'totalCost'])) || null;
    }
  }

  // --- daily -> totals + last-7-day "weekly" ---
  try {
    const data = await runCcusage(config, ['daily', '--json']);
    const daily = data.daily || data.data || [];
    const totals = data.totals || null;

    if (daily.length) {
      // sort by date ascending, take last 7
      const sorted = [...daily].sort((a, b) =>
        String(a.date).localeCompare(String(b.date))
      );
      const last7 = sorted.slice(-7);

      let wkTokens = 0;
      let wkCost = 0;
      for (const d of last7) {
        wkTokens += num(pick(d, ['totalTokens', 'total']));
        wkCost += num(pick(d, ['totalCost', 'costUSD']));
      }

      const budget = num(config?.plan?.weeklyTokenBudget);
      out.weekly = {
        utilization: budget > 0 ? Math.min(100, (wkTokens / budget) * 100) : null,
        resetsAt: null, // ccusage has no notion of the subscription weekly reset
        usedTokens: wkTokens,
        limitTokens: budget > 0 ? budget : null,
        label: 'Weekly (rolling 7 days)',
        estimated: true,
      };
      out.cost.week = wkCost || null;

      // today
      const todayStr = new Date().toISOString().slice(0, 10);
      const today = sorted.find((d) => String(d.date).startsWith(todayStr));
      if (today) out.cost.today = num(pick(today, ['totalCost', 'costUSD'])) || null;
    }

    if (totals) {
      out.tokens = tokenCounts(totals);
      out.cost.total = num(pick(totals, ['totalCost', 'costUSD'])) || null;
    }
  } catch (e) {
    out.warnings.push(`daily: ${e.message}`);
  }

  return out;
}

module.exports = { collect, runCcusage };
