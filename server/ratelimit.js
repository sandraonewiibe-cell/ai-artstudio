/**
 * A fixed-window rate limiter, per client address.
 *
 * The kiosk's two POST endpoints accept work: one starts a generation, the
 * other writes a file to disk. On a LAN that is fine, because the only caller
 * is the screen by the table. On a public URL anyone can call them, and an
 * unattended exhibition machine has no one watching the disk fill.
 *
 * Written here rather than pulled in, for the same reason SSE was preferred to
 * a socket library: it is a Map and a timestamp, and a dependency that has to
 * be kept patched is a worse trade than thirty lines.
 *
 * Fixed window rather than a sliding one. A visitor at a kiosk is nowhere near
 * the ceiling, so the usual objection - that a caller can send two windows'
 * worth across a boundary - costs nothing here, and the counter stays cheap.
 */

/** How the caller is identified. */
function clientKey(req) {
  // req.ip already honours X-Forwarded-For when the app trusts a proxy, and
  // ignores it when it does not - which is what keeps the header from being a
  // way to pick your own identity locally.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Builds a middleware that allows `max` requests per `windowMs` per caller.
 *
 * @param {{name: string, max: number, windowMs: number}} options
 * @returns {import('express').RequestHandler}
 */
function limit({ name, max, windowMs }) {
  /** @type {Map<string, {count: number, reset: number}>} */
  const hits = new Map();

  // Without this the Map grows by one entry per address, forever. An all-day
  // run behind a proxy sees a lot of addresses.
  const sweeper = setInterval(() => {
    const now = Date.now();
    hits.forEach((entry, key) => {
      if (entry.reset <= now) hits.delete(key);
    });
  }, Math.max(windowMs, 60 * 1000));
  sweeper.unref();

  return function rateLimiter(req, res, next) {
    if (!max || max < 0) return next(); // 0 disables the limit entirely

    const key = clientKey(req);
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    const secondsLeft = Math.max(1, Math.ceil((entry.reset - now) / 1000));

    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.set('RateLimit-Reset', String(secondsLeft));

    if (entry.count > max) {
      // Logged once per blocked request: on a kiosk this should never appear,
      // so if it does, it is worth seeing.
      console.warn(`[ratelimit] ${name}: ${key} blocked (${entry.count} in ${windowMs}ms)`);

      res.set('Retry-After', String(secondsLeft));
      return res.status(429).json({
        error: 'Too many requests. Please wait a moment and try again.',
        retryAfter: secondsLeft,
      });
    }

    return next();
  };
}

module.exports = { limit };
