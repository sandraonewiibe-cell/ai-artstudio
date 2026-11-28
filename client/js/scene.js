/**
 * What the wall is showing: boats on water, rockets in space, or fish in the
 * ocean - and the words that go with each.
 *
 * The wall decides from the background (see sceneOf) unless the panel says
 * outright. The scanner and the download screen ask the same question the
 * same way, so a visitor drawing a rocket is not told their boat is sailing.
 */

/**
 * The scene a picture or a video frame shows, measured on a small copy.
 *
 * Underwater is told two ways. Mostly clearly-blue-not-red; or, failing that,
 * mostly bluish with the light coming down from above - bright at the top, dark
 * at the bottom, which is how the sea looks from inside it. A lake or a sea
 * seen from above is lit evenly top to bottom. Measured on the kiosk's own
 * footage: an ocean video 0.80 blue and 72 brighter at the top; the lake video
 * that ships with it 0.55-0.59 blue and 1-2.
 */
export function sceneOf(source, sourceW, sourceH) {
  try {
    const w = 64;
    const h = Math.max(1, Math.round((sourceH / sourceW) * w));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);

    let dark = 0;
    let sea = 0;
    let bluish = 0;
    let top = 0;
    let bottom = 0;
    const band = Math.max(1, Math.floor(h / 4));
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luma = r * 0.299 + g * 0.587 + b * 0.114;
      const row = Math.floor(i / 4 / w);
      if (row < band) top += luma;
      if (row >= h - band) bottom += luma;
      if (b > r + 15) bluish += 1;
      if (luma < NIGHT_SKY.darkBelow) dark += 1;
      else if (b > r + UNDERWATER.blueOverRed && b + g > r * 2 + UNDERWATER.blueOverRed) sea += 1;
    }
    const total = w * h;
    const fall = (top - bottom) / (band * w);
    if (dark / total >= NIGHT_SKY.darkShare) return 'space';
    if (sea / total >= UNDERWATER.share) return 'ocean';
    if (bluish / total >= UNDERWATER.bluishShare && fall >= UNDERWATER.lightFall) return 'ocean';
    return 'water';
  } catch {
    return 'water';
  }
}

/**
 * What counts as a night sky. The kiosk's space picture is about nine tenths
 * dark by this measure; daytime water and sky are almost none.
 */
const NIGHT_SKY = { darkBelow: 70, darkShare: 0.6 };

/**
 * What counts as underwater: most of the picture clearly bluer than it is red,
 * and not dark - the sea seen from inside it. A boat picture has sky, shore or
 * a bright surface in it and falls short of this.
 */
const UNDERWATER = { blueOverRed: 30, share: 0.7, bluishShare: 0.8, lightFall: 35 };

/**
 * The scene for a set of display settings, worked out as the wall works it
 * out: what the panel chose, or - on Automatic - what the background looks
 * like. Resolves to 'water' if the background cannot be looked at.
 *
 * @param {{background?: {url?: string, type?: string, scene?: string}}} settings
 * @returns {Promise<'water'|'space'|'ocean'>}
 */
export async function sceneForSettings(settings) {
  const chosen = (settings && settings.background) || {};
  if (['water', 'space', 'ocean'].includes(chosen.scene)) return chosen.scene;
  if (!chosen.url) return 'water';

  const isImage =
    chosen.type === 'image' ||
    (chosen.type !== 'video' && /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(chosen.url));

  try {
    if (isImage) {
      const image = new Image();
      image.src = chosen.url;
      await image.decode();
      return sceneOf(image, image.naturalWidth, image.naturalHeight);
    }

    // A frame from a little way in, as the wall sees it once it is playing.
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = chosen.url;
    await new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('video would not load')), { once: true });
    });
    video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
    await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
    const scene = sceneOf(video, video.videoWidth, video.videoHeight);
    video.removeAttribute('src');
    video.load();
    return scene;
  } catch {
    return 'water';
  }
}

/**
 * The words for each scene, on the scanner and on the download screen.
 */
export const WORDS = {
  water: {
    creating: 'CREATING YOUR BOAT',
    generating: 'Getting your boat ready',
    sent: 'YOUR BOAT IS SAILING',
    sentDetail: 'Look up at the big screen.',
    rejectTitle: "WE COULDN'T FIND A BOAT",
    rejectDetail: 'Draw a boat on the paper and try again.',
    emptyDetail: 'Draw a boat on the paper, then place it under the camera.',
    takeHome: 'TAKE YOUR BOAT HOME',
    waiting: 'Waiting for the first boat…',
  },
  space: {
    creating: 'BUILDING YOUR ROCKET',
    generating: 'Fuelling your rocket',
    sent: 'YOUR ROCKET IS LAUNCHING',
    sentDetail: 'Look up at the big screen - 3, 2, 1, lift-off!',
    rejectTitle: "WE COULDN'T FIND A ROCKET",
    rejectDetail: 'Draw a rocket on the paper and try again.',
    emptyDetail: 'Draw a rocket on the paper, then place it under the camera.',
    takeHome: 'TAKE YOUR ROCKET HOME',
    waiting: 'Waiting for the first rocket…',
  },
  ocean: {
    creating: 'BRINGING YOUR FISH TO LIFE',
    generating: 'Filling the sea for your fish',
    sent: 'YOUR FISH IS SWIMMING',
    sentDetail: 'Look up at the big screen - watch it dive!',
    rejectTitle: "WE COULDN'T FIND A FISH",
    rejectDetail: 'Draw a fish on the paper and try again.',
    emptyDetail: 'Draw a fish on the paper, then place it under the camera.',
    takeHome: 'TAKE YOUR FISH HOME',
    waiting: 'Waiting for the first fish…',
  },
};

/** The words for a scene, boats if it is not one we know. */
export function wordsFor(scene) {
  return WORDS[scene] || WORDS.water;
}
