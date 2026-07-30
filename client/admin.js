/**
 * The admin panel.
 *
 * Reads the settings, lets whoever is running the exhibition change them, and
 * puts them back. Everything it touches is its own: it never calls a session
 * endpoint and the kiosk does not know it exists.
 *
 * No framework and no build step, for the same reason the rest of this project
 * has none - it is a form with a dozen fields, and it has to work on whatever
 * laptop is on the table on the day.
 */

const el = (id) => document.getElementById(id);

const TOKEN_KEY = 'aiartstudio.adminToken';

/** Held here between load and save, so the file inputs stay one-shot. */
let settings = null;

/** How many advertisements the server will keep. Told to us on the first read. */
let maxAds = Infinity;

// --- talking to the server ---------------------------------------------------

function headers() {
  const token = localStorage.getItem(TOKEN_KEY);
  return token
    ? { 'Content-Type': 'application/json', 'X-Admin-Token': token }
    : { 'Content-Type': 'application/json' };
}

/**
 * Asks for the token and retries, once.
 *
 * The panel only finds out a token is needed by being refused, which is the
 * right way round: a kiosk with no token set never sees a prompt at all.
 */
async function send(url, options) {
  let response = await fetch(url, { ...options, headers: headers() });

  if (response.status === 401) {
    const token = window.prompt('Admin token:');
    if (!token) throw new Error('An admin token is needed to save.');

    localStorage.setItem(TOKEN_KEY, token.trim());
    response = await fetch(url, { ...options, headers: headers() });
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Server returned ${response.status}`);

  return body;
}

/** Reads a chosen file as a data URL and stores it, returning its URL. */
async function upload(file, kind) {
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });

  return send('/api/media', { method: 'POST', body: JSON.stringify({ data, kind }) });
}

// --- the form ----------------------------------------------------------------

function show(message, tone = '') {
  const status = el('status');
  status.textContent = message;
  status.className = `status${tone ? ` is-${tone}` : ''}`;
}

function paintLogo(side) {
  const logo = settings.logos[side];
  const preview = el(`${side}Preview`);

  el(`${side}Enabled`).checked = logo.enabled;
  el(`${side}Size`).value = logo.size;

  preview.replaceChildren();

  if (!logo.url) {
    preview.textContent = 'No logo uploaded';
    return;
  }

  const image = document.createElement('img');
  image.src = logo.url;
  image.alt = '';

  const remove = document.createElement('button');
  remove.className = 'danger';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    settings.logos[side] = { enabled: false, url: null, size: logo.size };
    paintLogo(side);
    show('Removed. Save to apply.', '');
  });

  preview.append(image, remove);
}

function paintAds() {
  const { ads } = settings;

  el('adsEnabled').checked = ads.enabled;
  el('adPlacement').value = ads.placement;
  el('adDuration').value = ads.durationSec;
  el('adGap').value = ads.gapSec;
  describeCycle();

  const full = ads.items.length >= maxAds;
  el('adCount').textContent = Number.isFinite(maxAds)
    ? `(${ads.items.length} of ${maxAds})`
    : `(${ads.items.length})`;
  el('adFile').disabled = full;

  const list = el('adList');
  list.replaceChildren();

  if (!ads.items.length) {
    const empty = document.createElement('li');
    empty.className = 'name';
    empty.textContent = 'Nothing added yet.';
    list.appendChild(empty);
    return;
  }

  ads.items.forEach((item, index) => {
    const row = document.createElement('li');

    // Position in the rotation, since the order on screen is the order here.
    const order = document.createElement('span');
    order.className = 'order';
    order.textContent = index + 1;

    const media =
      item.type === 'video'
        ? Object.assign(document.createElement('video'), { src: item.url, muted: true })
        : Object.assign(document.createElement('img'), { src: item.url, alt: '' });

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${item.type} — ${item.url.replace('/media/', '')}`;

    row.append(order, media, name, move(index, -1, '↑'), move(index, 1, '↓'));

    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      settings.ads.items.splice(index, 1);
      paintAds();
      show('Removed. Save to apply.');
    });

    row.appendChild(remove);
    list.appendChild(row);
  });
}

/** Nudges an advertisement up or down the running order. */
function move(index, by, label) {
  const button = document.createElement('button');
  button.textContent = label;
  button.title = by < 0 ? 'Show earlier' : 'Show later';

  const target = index + by;
  button.disabled = target < 0 || target >= settings.ads.items.length;

  button.addEventListener('click', () => {
    const items = settings.ads.items;
    [items[index], items[target]] = [items[target], items[index]];
    paintAds();
    show('Reordered. Save to apply.');
  });

  return button;
}

function paint() {
  paintLogo('left');
  paintLogo('right');
  paintAds();
}

/** Reads the form back into the settings object, ready to send. */
function collect() {
  ['left', 'right'].forEach((side) => {
    settings.logos[side].enabled = el(`${side}Enabled`).checked;
    settings.logos[side].size = Number(el(`${side}Size`).value);
  });

  settings.ads.enabled = el('adsEnabled').checked;
  settings.ads.placement = el('adPlacement').value;
  settings.ads.durationSec = Number(el('adDuration').value);
  settings.ads.gapSec = Number(el('adGap').value);

  return settings;
}

/**
 * Spells the cycle out in words.
 *
 * Two numbers a few fields apart do not obviously add up to a rhythm, and the
 * thing being configured here is a rhythm - so it is written out rather than
 * left to be worked out.
 */
function describeCycle() {
  const show = Number(el('adDuration').value) || 0;
  const gap = Number(el('adGap').value) || 0;
  const count = settings ? settings.ads.items.length : 0;

  if (!show || !gap) {
    el('adCycle').textContent = '';
    return;
  }

  const each = count > 1 ? 'each advertisement' : 'the advertisement';
  el('adCycle').textContent =
    `Cycle: ${each} for ${show}s, then ${gap}s of clear wall, then round again` +
    (count > 1 ? ` — ${count} in rotation, ${(show + gap) * count}s for a full round.` : '.');
}

// --- wiring ------------------------------------------------------------------

async function load() {
  try {
    const body = await send('/api/settings', { method: 'GET' });

    // The server says how many advertisements it will keep; the panel stops
    // there rather than letting somebody upload past it and lose them on save.
    if (body.limits && Number.isFinite(body.limits.ads)) maxAds = body.limits.ads;

    settings = body;
    paint();
    show('');
  } catch (err) {
    show(err.message, 'error');
  }
}

['left', 'right'].forEach((side) => {
  el(`${side}File`).addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    show('Uploading…');
    try {
      const stored = await upload(file, 'logo');
      settings.logos[side].url = stored.url;
      settings.logos[side].enabled = true;
      paintLogo(side);
      show('Uploaded. Save to apply.', 'good');
    } catch (err) {
      show(err.message, 'error');
    } finally {
      event.target.value = '';
    }
  });
});

/**
 * Takes however many files were chosen at once.
 *
 * One at a time rather than all together on purpose: an advertisement can be a
 * video, and firing a dozen of those at the server in parallel is how you make
 * a kiosk feel broken. Each one appears in the list as it lands, so a slow
 * upload looks like progress rather than like nothing happening.
 */
el('adFile').addEventListener('change', async (event) => {
  const chosen = [...event.target.files];
  if (!chosen.length) return;

  const room = maxAds - settings.ads.items.length;
  const files = chosen.slice(0, Math.max(0, room));

  let added = 0;
  let failed = 0;

  for (const [index, file] of files.entries()) {
    show(files.length > 1 ? `Uploading ${index + 1} of ${files.length}…` : 'Uploading…');

    try {
      const stored = await upload(file, 'ad');
      settings.ads.items.push({ id: stored.url, url: stored.url, type: stored.type });
      settings.ads.enabled = true;
      added += 1;
      paintAds();
    } catch (err) {
      failed += 1;
      console.warn(`[admin] ${file.name} did not upload:`, err.message);
    }
  }

  event.target.value = '';

  // Say what happened to every file, including the ones that did not fit -
  // silently dropping somebody's last three uploads reads as a bug.
  const parts = [];
  if (added) parts.push(`Added ${added}.`);
  if (failed) parts.push(`${failed} failed — see the console.`);
  if (chosen.length > files.length) {
    parts.push(`${chosen.length - files.length} not added: ${maxAds} is the most.`);
  }
  parts.push('Save to apply.');

  show(parts.join(' '), failed || chosen.length > files.length ? 'error' : 'good');
});

el('save').addEventListener('click', async () => {
  show('Saving…');

  try {
    // The server cleans and clamps whatever it is sent, and answers with what
    // it actually stored - so the form is repainted from that rather than from
    // what was typed, and shows the truth.
    settings = await send('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(collect()),
    });

    paint();
    show('Saved. The wall is showing it now.', 'good');
  } catch (err) {
    show(err.message, 'error');
  }
});

// Keep the description in step as the numbers are typed, before any save.
['adDuration', 'adGap'].forEach((id) => {
  el(id).addEventListener('input', describeCycle);
});

el('reload').addEventListener('click', () => {
  show('Reloading…');
  load();
});

load();
