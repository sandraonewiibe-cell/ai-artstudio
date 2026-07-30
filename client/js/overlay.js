/**
 * The organiser's logos and advertisements, over the top of the wall.
 *
 * Deliberately not part of the canvas. The canvas is the boat, and it records
 * itself - anything drawn into it ends up in the clip the visitor takes home,
 * which is right for a boat and wrong for an advertisement. Keeping this in
 * front of the canvas as ordinary elements also means the boat's own drawing
 * code is not touched at all, so none of this can affect what the wall does
 * when nobody has configured anything.
 *
 * Builds its own elements, so the page it sits on needs no markup for it.
 */

const AD_FADE_MS = 400;

/** How soon the first advertisement appears once the settings arrive. */
const FIRST_SHOW_MS = 1500;

/**
 * The shortest gap between one advertisement ending and the next beginning.
 *
 * The gap normally comes out of the frequency - an advertisement every 90
 * seconds that runs for 10 leaves 80 seconds of wall. This is the floor, for
 * when the two numbers are set close together or the wrong way round: without
 * it, a 30-second advertisement shown "every 30 seconds" would never be off
 * the screen, and the wall would be an advertisement with a boat occasionally
 * behind it.
 */
const MIN_GAP_MS = 3000;

/** Never wait longer than this for a picture or a video to have a frame. */
const READY_TIMEOUT_MS = 1500;

export function createOverlay(parent = document.body) {
  const root = document.createElement('div');
  root.className = 'wall-overlay';

  const logos = {
    left: logoElement('left'),
    right: logoElement('right'),
  };

  const ad = document.createElement('div');
  ad.className = 'wall-ad';
  ad.hidden = true;

  root.append(logos.left, logos.right, ad);
  parent.appendChild(root);

  /** The next thing the rotation will do, and the teardown after a fade. */
  let turn = null;
  let teardown = null;

  let next = 0;
  let config = null;

  function applyLogos(settings) {
    ['left', 'right'].forEach((side) => {
      const wanted = settings.logos[side];
      const node = logos[side];

      if (!wanted.enabled || !wanted.url) {
        node.hidden = true;
        node.removeAttribute('src');
        return;
      }

      if (node.getAttribute('src') !== wanted.url) node.src = wanted.url;
      node.style.height = `${wanted.size}vh`;
      node.hidden = false;
    });
  }

  const running = () => Boolean(config && config.ads.enabled && config.ads.items.length);

  function stop() {
    window.clearTimeout(turn);
    window.clearTimeout(teardown);
    turn = null;
    teardown = null;
  }

  /** Empties the frame, stopping any video first. */
  function clearMedia() {
    const media = ad.firstElementChild;

    // A video that is torn out of the page while it is still decoding can
    // flash as its layer goes. Stopped and unhooked first, it goes quietly.
    if (media && media.tagName === 'VIDEO') {
      media.pause();
      media.removeAttribute('src');
      media.load();
    }

    ad.replaceChildren();
  }

  function hide() {
    ad.classList.remove('is-visible');

    // Held in the page for the length of the fade, then emptied and taken out
    // of the compositor entirely - an element left behind is one that can
    // still show something.
    window.clearTimeout(teardown);
    teardown = window.setTimeout(() => {
      clearMedia();
      ad.hidden = true;
    }, AD_FADE_MS);
  }

  async function show() {
    if (!running()) return;

    const item = config.ads.items[next % config.ads.items.length];
    next += 1;

    // Cancel any pending teardown before touching the frame, or it will empty
    // the advertisement that is being put into it.
    window.clearTimeout(teardown);

    const media = build(item);
    clearMedia();
    ad.replaceChildren(media);
    ad.hidden = false;

    // Faded in only once there is actually a frame to show. Fading in an
    // empty element and letting it fill afterwards is the flash of light that
    // used to appear around an advertisement.
    await hasFrame(media);

    // The settings may have changed while that was loading.
    if (!running() || ad.firstElementChild !== media) return;

    ad.classList.add('is-visible');

    const duration = config.ads.durationSec * 1000;
    turn = window.setTimeout(rest, duration);
  }

  /** Off the screen for a while, then round again. */
  function rest() {
    hide();

    if (!running()) return;

    const period = config.ads.frequencySec * 1000;
    const duration = config.ads.durationSec * 1000;
    const gap = Math.max(MIN_GAP_MS, period - duration);

    turn = window.setTimeout(show, gap);
  }

  function restart() {
    stop();
    hide();

    // Back to the top of the list. The panel numbers the advertisements and
    // says they play in that order, so after a save they should start at the
    // first one rather than wherever the previous list happened to have got to.
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
      ad.dataset.placement = settings.ads.placement;

      // Only restart the rotation when its shape actually changed; otherwise a
      // save that only moved a logo would cut an advertisement off mid-show.
      const key = (s) =>
        s
          ? `${s.ads.enabled}|${s.ads.frequencySec}|${s.ads.durationSec}|${s.ads.items.map((i) => i.url).join()}`
          : '';

      if (key(before) !== key(settings)) restart();
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

    const ready =
      media.tagName === 'VIDEO' ? media.readyState >= 2 : media.complete && media.naturalWidth > 0;

    if (ready) return done();

    media.addEventListener(media.tagName === 'VIDEO' ? 'loadeddata' : 'load', done, { once: true });
    media.addEventListener('error', done, { once: true });

    return undefined;
  });
}

function logoElement(side) {
  const node = document.createElement('img');
  node.className = `wall-logo is-${side}`;
  node.alt = '';
  node.hidden = true;
  return node;
}
