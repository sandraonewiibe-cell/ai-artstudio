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
  el('adFrequency').value = ads.frequencySec;

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

    const media =
      item.type === 'video'
        ? Object.assign(document.createElement('video'), { src: item.url, muted: true })
        : Object.assign(document.createElement('img'), { src: item.url, alt: '' });

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${item.type} — ${item.url.replace('/media/', '')}`;

    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      settings.ads.items.splice(index, 1);
      paintAds();
      show('Removed. Save to apply.', '');
    });

    row.append(media, name, remove);
    list.appendChild(row);
  });
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
  settings.ads.frequencySec = Number(el('adFrequency').value);

  return settings;
}

// --- wiring ------------------------------------------------------------------

async function load() {
  try {
    settings = await send('/api/settings', { method: 'GET' });
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

el('adFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  show('Uploading…');
  try {
    const stored = await upload(file, 'ad');
    settings.ads.items.push({ id: stored.url, url: stored.url, type: stored.type });
    settings.ads.enabled = true;
    paintAds();
    show('Uploaded. Save to apply.', 'good');
  } catch (err) {
    show(err.message, 'error');
  } finally {
    event.target.value = '';
  }
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

el('reload').addEventListener('click', () => {
  show('Reloading…');
  load();
});

load();
