/**
 * The organiser's logos and advertisements.
 *
 * This module owns the *schedule* - which advertisement is up, for how long,
 * and how far through its fade it is. It draws nothing. The pictures and videos
 * it holds live off-screen, purely as something for the canvas to copy from,
 * and the Stage paints them as part of the wall.
 *
 * That is the whole point of the arrangement: the wall records itself, so
 * anything laid *over* the canvas is missing from the clip the visitor takes
 * home. Painting into the canvas instead means there is one picture, and the
 * recording cannot show something different from the wall because it is the
 * same pixels.
 */

const FADE_MS = 400;

/** How soon the first advertisement appears once the settings arrive. */
const FIRST_SHOW_MS = 1500;

/** Never wait longer than this for a picture or a video to have a frame. */
const READY_TIMEOUT_MS = 1500;

export function createOverlay(parent = document.body) {
  // Off-screen, but in the page: a video that is not in the document may not
  // decode, and one that is `display: none` certainly will not.
  const sources = document.createElement('div');
  sources.className = 'offscreen-source';
  parent.appendChild(sources);

  const logos = {
    left: { node: logoElement(), size: 10, enabled: false },
    right: { node: logoElement(), size: 10, enabled: false },
  };
  sources.append(logos.left.node, logos.right.node);

  /** The advertisement currently on the wall, if any. */
  let media = null;
  let placement = 'bottom';

  /** The fade, as two ends and a start time - there is no CSS to do it here. */
  let fade = { from: 0, to: 0, at: 0 };

  let turn = null;
  let teardown = null;
  let next = 0;
  let config = null;

  const now = () => performance.now();

  function opacity(at) {
    const progress = Math.min(1, Math.max(0, (at - fade.at) / FADE_MS));
    return fade.from + (fade.to - fade.from) * progress;
  }

  function fadeTo(to) {
    fade = { from: opacity(now()), to, at: now() };
  }

  function applyLogos(settings) {
    ['left', 'right'].forEach((side) => {
      const wanted = settings.logos[side];
      const logo = logos[side];

      logo.enabled = Boolean(wanted.enabled && wanted.url);
      logo.size = wanted.size;

      if (!logo.enabled) {
        logo.node.removeAttribute('src');
        return;
      }

      if (logo.node.getAttribute('src') !== wanted.url) logo.node.src = wanted.url;
    });
  }

  const running = () => Boolean(config && config.ads.enabled && config.ads.items.length);

  function stop() {
    window.clearTimeout(turn);
    window.clearTimeout(teardown);
    turn = null;
    teardown = null;
  }

  function drop() {
    if (media && media.tagName === 'VIDEO') {
      media.pause();
      media.removeAttribute('src');
      media.load();
    }

    if (media && media.parentNode) media.parentNode.removeChild(media);
    media = null;
  }

  function hide() {
    fadeTo(0);

    // Kept as a source for the length of the fade, then let go.
    window.clearTimeout(teardown);
    teardown = window.setTimeout(drop, FADE_MS);
  }

  async function show() {
    if (!running()) return;

    const item = config.ads.items[next % config.ads.items.length];
    next += 1;

    window.clearTimeout(teardown);
    drop();

    const element = build(item);
    sources.appendChild(element);
    media = element;

    // Only faded up once there is a frame to show. Fading in an empty element
    // and letting it fill afterwards is the flash of light that used to appear.
    await hasFrame(element);

    // The settings may have changed while that was loading.
    if (!running() || media !== element) return;

    fadeTo(1);
    turn = window.setTimeout(rest, config.ads.durationSec * 1000);
  }

  /**
   * The break. Nothing on the wall for the configured seconds, then round to
   * the next advertisement - which for a single one is the same one again.
   */
  function rest() {
    hide();

    if (!running()) return;
    turn = window.setTimeout(show, config.ads.gapSec * 1000);
  }

  function restart() {
    stop();
    hide();

    // Back to the top of the list. The panel numbers the advertisements, so
    // after a save they should start at the first one rather than wherever the
    // previous list had got to.
    next = 0;

    if (!running()) return;
    turn = window.setTimeout(show, FIRST_SHOW_MS);
  }

  return {
    /** Applies a settings object, live. Safe to call as often as you like. */
    apply(settings) {
      if (!settings || !settings.logos || !settings.ads) return;

      const before = config;
      config = settings;

      applyLogos(settings);
      placement = settings.ads.placement;

      // Only restart the rotation when its shape actually changed; otherwise a
      // save that only moved a logo would cut an advertisement off mid-show.
      const key = (s) =>
        s
          ? `${s.ads.enabled}|${s.ads.gapSec}|${s.ads.durationSec}|${s.ads.items.map((i) => i.url).join()}`
          : '';

      if (key(before) !== key(settings)) restart();
    },

    /**
     * What should be on the wall at this instant, for the Stage to paint.
     *
     * Anything without a frame yet is left out rather than drawn as a gap.
     */
    frame(at) {
      const alpha = opacity(at);

      return {
        logos: ['left', 'right']
          .filter((side) => logos[side].enabled && logos[side].node.naturalWidth > 0)
          .map((side) => ({ side, image: logos[side].node, size: logos[side].size })),

        ad:
          media && alpha > 0.01 && hasPixels(media)
            ? { media, placement, opacity: alpha }
            : null,
      };
    },
  };
}

function build(item) {
  if (item.type !== 'video') {
    return Object.assign(document.createElement('img'), { src: item.url, alt: '' });
  }

  return Object.assign(document.createElement('video'), {
    src: item.url,
    autoplay: true,
    loop: true,
    muted: true,
    playsInline: true,
  });
}

function hasPixels(media) {
  return media.tagName === 'VIDEO'
    ? media.readyState >= 2 && media.videoWidth > 0
    : media.naturalWidth > 0;
}

/**
 * Settles once the media has something to draw, or gives up waiting.
 *
 * The timeout matters more than the event: a file that never loads must not
 * leave the rotation stuck on it forever with a blank frame on the wall.
 */
function hasFrame(media) {
  return new Promise((resolve) => {
    let waiting = true;

    const done = () => {
      if (!waiting) return;
      waiting = false;
      window.clearTimeout(bail);
      resolve();
    };

    const bail = window.setTimeout(done, READY_TIMEOUT_MS);

    if (hasPixels(media)) return done();

    media.addEventListener(media.tagName === 'VIDEO' ? 'loadeddata' : 'load', done, { once: true });
    media.addEventListener('error', done, { once: true });

    return undefined;
  });
}

function logoElement() {
  const node = document.createElement('img');
  node.alt = '';
  return node;
}
