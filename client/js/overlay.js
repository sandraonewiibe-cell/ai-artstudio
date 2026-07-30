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

  /** While a boat is crossing, advertisements wait. */
  let busy = false;

  let schedule = null;
  let showing = null;
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

  function hideAd() {
    ad.classList.remove('is-visible');

    // Left in the DOM for the length of the fade, then emptied - a video that
    // stays in the page keeps decoding behind an invisible element.
    window.setTimeout(() => {
      if (ad.classList.contains('is-visible')) return;
      ad.hidden = true;
      ad.replaceChildren();
    }, AD_FADE_MS);
  }

  function showAd() {
    if (!config || !config.ads.enabled || !config.ads.items.length) return;

    // Never over a boat. The advertisement waits for the next turn rather than
    // queueing, so it cannot pile up behind a busy spell.
    if (busy) return;

    const item = config.ads.items[next % config.ads.items.length];
    next += 1;

    const media =
      item.type === 'video'
        ? Object.assign(document.createElement('video'), {
            src: item.url,
            autoplay: true,
            loop: true,
            muted: true,
            playsInline: true,
          })
        : Object.assign(document.createElement('img'), { src: item.url, alt: '' });

    ad.replaceChildren(media);
    ad.hidden = false;

    // Next frame, so the transition has a start state to move from.
    requestAnimationFrame(() => ad.classList.add('is-visible'));

    window.clearTimeout(showing);
    showing = window.setTimeout(hideAd, config.ads.durationSec * 1000);
  }

  function restartSchedule() {
    window.clearInterval(schedule);
    window.clearTimeout(showing);
    hideAd();

    if (!config || !config.ads.enabled || !config.ads.items.length) return;

    schedule = window.setInterval(showAd, config.ads.frequencySec * 1000);
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
        s ? `${s.ads.enabled}|${s.ads.frequencySec}|${s.ads.durationSec}|${s.ads.items.map((i) => i.url).join()}` : '';

      if (key(before) !== key(settings)) restartSchedule();
    },

    /** Told by the display when a boat is on screen. */
    setBusy(value) {
      busy = Boolean(value);
      if (busy) hideAd();
    },
  };
}

function logoElement(side) {
  const node = document.createElement('img');
  node.className = `wall-logo is-${side}`;
  node.alt = '';
  node.hidden = true;
  return node;
}
