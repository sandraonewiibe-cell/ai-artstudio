import { connect } from './js/bus.js';

/**
 * Screen 3 - the download QR.
 *
 * Shows a QR for the most recent recording. The code encodes the machine's LAN
 * address rather than localhost, since the phone scanning it is a different
 * device on the network.
 */

const frame = document.getElementById('qrFrame');
const image = document.getElementById('qrImage');
const caption = document.getElementById('qrCaption');
const name = document.getElementById('qrName');

let currentId = null;

function show(record) {
  if (!record || record.id === currentId) return;
  currentId = record.id;

  image.src = `/api/qr?size=720&data=${encodeURIComponent(record.downloadUrl)}`;
  frame.hidden = false;

  caption.textContent = 'Scan with your phone to download';
  name.textContent = record.text ? `“${record.text}”` : '';
}

function waiting(message) {
  frame.hidden = true;
  currentId = null;
  caption.textContent = message;
  name.textContent = '';
}

async function loadLatest() {
  try {
    const response = await fetch('/api/recordings/latest');
    if (response.status === 404) {
      waiting('Waiting for the first boat…');
      return;
    }
    if (!response.ok) throw new Error(`Server returned ${response.status}`);

    show(await response.json());
  } catch (err) {
    console.warn('[qr] could not load the latest recording:', err.message);
  }
}

connect(
  (event) => {
    if (event.type === 'recording' && event.recording) show(event.recording);
  },
  {
    onOpen: loadLatest,
    onDown: () => {
      // Keep the current code on screen - a visitor may still be scanning it.
      console.warn('[qr] event stream down; retrying');
    },
  }
);

loadLatest();
