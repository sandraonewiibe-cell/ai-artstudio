const fs = require('fs');
const path = require('path');

const config = require('./config');

/**
 * Settings the exhibition organiser controls from /admin: the logos on the
 * display wall and the advertisements between boats.
 *
 * Kept in one small JSON file rather than a database - there is one of these
 * per kiosk and it is read once at boot and on every save. It lives outside
 * uploads/ and generated/ on purpose, because those are swept on a timer and
 * a logo is not a leftover.
 *
 * Nothing here touches a session. If this file is missing, unreadable or
 * nonsense, the defaults apply and the kiosk runs exactly as it did before the
 * panel existed.
 */

const FILE = path.join(config.paths.data, 'settings.json');

const PLACEMENTS = ['fullscreen', 'top', 'bottom', 'left', 'right'];
const MAX_ADS = 12;

function defaults() {
  return {
    logos: {
      left: { enabled: false, url: null, size: 10 },
      right: { enabled: false, url: null, size: 10 },
    },
    ads: {
      enabled: false,
      placement: 'bottom',

      // How long one advertisement stays on the wall...
      durationSec: 10,

      // ...and how long the wall is clear before the next one. The two of them
      // are the whole cycle: shown, break, shown, break, round and round.
      gapSec: 20,

      items: [],
    },
  };
}

/** @type {object|null} */
let current = null;

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * Only paths this server produced.
 *
 * The panel sends back whatever it was given, and a URL is the one field an
 * organiser could paste anything into - including somewhere off this machine.
 * Anything that is not a file we wrote to /media is dropped.
 */
function ownUrl(url) {
  if (typeof url !== 'string') return null;
  if (!/^\/media\/[A-Za-z0-9._-]+$/.test(url)) return null;
  if (url.includes('..')) return null;
  return url;
}

function cleanLogo(input, fallback) {
  const logo = input && typeof input === 'object' ? input : {};
  const url = ownUrl(logo.url) || fallback.url;

  return {
    // A logo with no image cannot be on, whatever the panel says.
    enabled: Boolean(logo.enabled) && Boolean(url),
    url,
    size: clamp(logo.size, 2, 30, fallback.size),
  };
}

function cleanAds(input, fallback) {
  const ads = input && typeof input === 'object' ? input : {};
  const raw = Array.isArray(ads.items) ? ads.items : fallback.items;

  const items = raw
    .map((item) => {
      const url = ownUrl(item && item.url);
      if (!url) return null;

      return {
        id: typeof item.id === 'string' ? item.id.slice(0, 64) : url,
        url,
        type: item.type === 'video' ? 'video' : 'image',
      };
    })
    .filter(Boolean)
    .slice(0, MAX_ADS);

  const durationSec = clamp(ads.durationSec, 1, 120, fallback.durationSec);

  return {
    enabled: Boolean(ads.enabled) && items.length > 0,
    placement: PLACEMENTS.includes(ads.placement) ? ads.placement : fallback.placement,
    durationSec,
    gapSec: breakBetween(ads, durationSec, fallback.gapSec),
    items,
  };
}

/**
 * How long the wall stays clear between advertisements.
 *
 * Settings saved before this field existed carried a frequency instead - how
 * often an advertisement *started* - and the break was whatever was left over
 * once it had been on screen. Those are read back as the break they worked out
 * to, so a kiosk that has been set up already keeps the timing it had.
 */
function breakBetween(ads, durationSec, fallback) {
  if (ads.gapSec !== undefined) return clamp(ads.gapSec, 1, 600, fallback);

  const frequency = Number(ads.frequencySec);
  if (Number.isFinite(frequency)) return clamp(frequency - durationSec, 1, 600, fallback);

  return fallback;
}

/** Everything the panel can send, put through a sieve. */
function clean(input) {
  const base = defaults();
  const patch = input && typeof input === 'object' ? input : {};
  const logos = patch.logos && typeof patch.logos === 'object' ? patch.logos : {};

  return {
    logos: {
      left: cleanLogo(logos.left, base.logos.left),
      right: cleanLogo(logos.right, base.logos.right),
    },
    ads: cleanAds(patch.ads, base.ads),
  };
}

function load() {
  try {
    current = clean(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[settings] could not read ${FILE} (${err.message}); using defaults`);
    }
    current = defaults();
  }

  return current;
}

function get() {
  return current || load();
}

/**
 * Replaces the settings and writes them out.
 *
 * Written to a temporary file and renamed, so a kiosk losing power mid-save
 * comes back to the settings it had rather than to half a file.
 *
 * @returns {object} the settings as stored, after cleaning
 */
function save(input) {
  const next = clean(input);

  fs.mkdirSync(config.paths.data, { recursive: true });

  const temporary = `${FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
  fs.renameSync(temporary, FILE);

  current = next;
  return current;
}

module.exports = { get, load, save, defaults, PLACEMENTS, MAX_ADS };
