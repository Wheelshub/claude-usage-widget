'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Resolve a Claude OAuth access token for the /api/oauth/usage endpoint.
 *
 * Resolution order:
 *   1. config.oauth.manualToken (if set)
 *   2. process.env[config.oauth.tokenEnvVar]   (default CLAUDE_CODE_OAUTH_TOKEN)
 *   3. ~/.claude/.credentials.json -> claudeAiOauth.accessToken
 *
 * This runs in the USER's own process reading the USER's own token, the same
 * way community status-line tools do. The token is never logged or written out.
 */
function resolveToken(config) {
  const oauth = (config && config.oauth) || {};

  if (oauth.manualToken && oauth.manualToken.trim()) {
    return { token: oauth.manualToken.trim(), from: 'config.manualToken' };
  }

  const envVar = oauth.tokenEnvVar || 'CLAUDE_CODE_OAUTH_TOKEN';
  if (process.env[envVar]) {
    return { token: process.env[envVar].trim(), from: `env:${envVar}` };
  }

  const credPath =
    (oauth.credentialsPath && oauth.credentialsPath.trim()) ||
    path.join(os.homedir(), '.claude', '.credentials.json');

  try {
    const raw = fs.readFileSync(credPath, 'utf8');
    const data = JSON.parse(raw);
    // Known shapes across Claude Code versions.
    const token =
      data?.claudeAiOauth?.accessToken ||
      data?.claudeAiOauth?.access_token ||
      data?.accessToken ||
      data?.access_token ||
      null;
    if (token) return { token, from: credPath };
    return { token: null, from: credPath, error: 'No accessToken field found in credentials file.' };
  } catch (err) {
    return {
      token: null,
      from: credPath,
      error: `Could not read credentials (${err.code || err.message}).`,
    };
  }
}

module.exports = { resolveToken };
