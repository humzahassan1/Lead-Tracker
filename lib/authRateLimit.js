const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 5;

const authAttempts = new Map();

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function makeAuthKey(scope, ip, identifier = '') {
  const id = String(identifier || '').toLowerCase().trim();
  return id ? `${scope}:${ip}:${id}` : `${scope}:${ip}`;
}

function checkAuthRateLimit(key) {
  const now = Date.now();
  let entry = authAttempts.get(key);

  if (entry?.lockedUntil && now < entry.lockedUntil) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000),
      attempts: entry.count,
    };
  }

  if (!entry || now - entry.windowStart >= AUTH_WINDOW_MS) {
    entry = { count: 0, windowStart: now, lockedUntil: null };
  }

  if (entry.count >= AUTH_MAX_ATTEMPTS) {
    entry.lockedUntil = entry.windowStart + AUTH_WINDOW_MS;
    authAttempts.set(key, entry);
    return {
      allowed: false,
      retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000),
      attempts: entry.count,
    };
  }

  entry.count += 1;
  authAttempts.set(key, entry);

  return {
    allowed: true,
    remaining: AUTH_MAX_ATTEMPTS - entry.count,
    attempts: entry.count,
  };
}

function sendRateLimitResponse(res, retryAfterSec) {
  res.set('Retry-After', String(retryAfterSec));
  return res.status(429).json({
    error: 'rate_limited',
    message: `Too many attempts. Try again in ${retryAfterSec} seconds.`,
    retryAfterSec,
  });
}

function authRateLimit(scope, getIdentifier = () => '') {
  return (req, res, next) => {
    const ip = getClientIp(req);
    const identifier = getIdentifier(req) || '';
    const ipKey = makeAuthKey(scope, ip);
    const scopedKey = identifier ? makeAuthKey(scope, ip, identifier) : null;

    const ipResult = checkAuthRateLimit(ipKey);
    if (!ipResult.allowed) {
      return sendRateLimitResponse(res, ipResult.retryAfterSec);
    }

    if (scopedKey) {
      const scopedResult = checkAuthRateLimit(scopedKey);
      if (!scopedResult.allowed) {
        return sendRateLimitResponse(res, scopedResult.retryAfterSec);
      }
    }

    next();
  };
}

function pruneAuthAttempts() {
  const now = Date.now();
  for (const [key, entry] of authAttempts) {
    const windowExpired = now - entry.windowStart >= AUTH_WINDOW_MS;
    const lockExpired = !entry.lockedUntil || now >= entry.lockedUntil;
    if (windowExpired && lockExpired) authAttempts.delete(key);
  }
}

const pruneTimer = setInterval(pruneAuthAttempts, 60 * 1000);
if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

module.exports = {
  AUTH_MAX_ATTEMPTS,
  AUTH_WINDOW_MS,
  authRateLimit,
  checkAuthRateLimit,
  makeAuthKey,
  pruneAuthAttempts,
};
