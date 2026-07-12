#!/usr/bin/env node
/**
 * Smoke test: 6th auth attempt should return 429.
 * Usage: node scripts/test-auth-rate-limit.js [baseUrl]
 */
const { checkAuthRateLimit, makeAuthKey, AUTH_MAX_ATTEMPTS } = require('../lib/authRateLimit');

const baseUrl = process.argv[2] || 'http://localhost:3000';
const testIp = '203.0.113.50';
const key = makeAuthKey('login', testIp);

console.log(`Auth rate limit unit check (${AUTH_MAX_ATTEMPTS} allowed per window):`);
for (let i = 1; i <= AUTH_MAX_ATTEMPTS + 1; i += 1) {
  const result = checkAuthRateLimit(key);
  console.log(`  attempt ${i}: ${result.allowed ? `allowed (${result.remaining} left)` : `BLOCKED 429, retry in ${result.retryAfterSec}s`}`);
}

async function integrationCheck() {
  console.log(`\nIntegration check against ${baseUrl}/auth/login:`);
  let blocked = false;
  for (let i = 1; i <= AUTH_MAX_ATTEMPTS + 1; i += 1) {
    const res = await fetch(`${baseUrl}/auth/login`, { redirect: 'manual' });
    const status = res.status;
    console.log(`  attempt ${i}: HTTP ${status}`);
    if (i === AUTH_MAX_ATTEMPTS + 1 && status === 429) blocked = true;
  }
  if (blocked) {
    console.log('\nPASS: 6th login attempt returned 429.');
  } else {
    console.log('\nNOTE: Start the server and re-run, or prior attempts may have consumed the window.');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  integrationCheck().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
