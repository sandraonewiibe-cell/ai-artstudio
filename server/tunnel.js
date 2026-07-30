const { spawn } = require('child_process');

const network = require('./network');
const events = require('./events');

/**
 * Makes the kiosk reachable from outside its own network.
 *
 * A LAN address only works for a phone on the same wifi. For a visitor on mobile
 * data the connection has to come in from the internet, which needs a tunnel: a
 * long-lived outbound connection to a relay that forwards traffic back.
 *
 * Two providers, both chosen so nothing has to be signed up for:
 *
 *   ssh         - uses localhost.run over the OpenSSH client that ships with
 *                 Windows. Nothing to install, works immediately. Free relays
 *                 come and go, so it is the convenient option rather than the
 *                 dependable one.
 *   cloudflared - Cloudflare's client. One .exe to download, and markedly more
 *                 reliable for something running all day. Use this for the real
 *                 exhibition.
 *
 * The URL is discovered by watching the child process's output, then handed to
 * network.js so every QR code from that point on uses it. If the tunnel drops it
 * is restarted, and the new URL is broadcast so the QR screen re-renders.
 */

const PROVIDERS = {
  ssh: (port) => ({
    command: 'ssh',
    args: [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ExitOnForwardFailure=yes',
      '-R', `80:localhost:${port}`,
      'nokey@localhost.run',
    ],
    pattern: /https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)/i,
  }),

  cloudflared: (port) => ({
    command: 'cloudflared',
    args: ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`],
    pattern: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
  }),
};

const RETRY_MS = 5000;
const MAX_RETRY_MS = 60000;

let child = null;
let retry = RETRY_MS;
let stopped = false;

/**
 * Starts a tunnel and keeps it up.
 *
 * @param {string} provider 'ssh' | 'cloudflared'
 * @param {number} port
 */
function start(provider, port) {
  const build = PROVIDERS[provider];

  if (!build) {
    console.warn(
      `[tunnel] unknown provider "${provider}"; expected one of ${Object.keys(PROVIDERS).join(', ')}`
    );
    return;
  }

  stopped = false;
  launch(build(port), provider, port);
}

function launch(config, provider, port) {
  if (stopped) return;

  console.log(`[tunnel] starting ${provider}...`);

  try {
    child = spawn(config.command, config.args, { windowsHide: true });
  } catch (err) {
    console.warn(`[tunnel] could not run ${config.command}: ${err.message}`);
    scheduleRetry(config, provider, port);
    return;
  }

  let announced = false;

  // Providers print the URL on either stream, so watch both.
  const watch = (chunk) => {
    const text = chunk.toString();
    const match = text.match(config.pattern);
    if (!match || announced) return;

    announced = true;
    retry = RETRY_MS;

    const url = network.setPublicUrl(match[0]);
    console.log(`[tunnel] public url: ${url}`);
    console.log('[tunnel] QR codes will now work from any network');

    // Existing recordings get their download link recomputed from this, so the
    // QR screen only needs telling that something changed.
    events.broadcast('tunnel', { publicUrl: url });
  };

  child.stdout?.on('data', watch);
  child.stderr?.on('data', watch);

  child.on('error', (err) => {
    console.warn(`[tunnel] ${provider} failed: ${err.message}`);
    if (err.code === 'ENOENT') {
      console.warn(`[tunnel] ${config.command} is not installed or not on PATH`);
    }
  });

  child.on('exit', (code) => {
    child = null;
    if (stopped) return;

    console.warn(`[tunnel] ${provider} exited (${code}); the public url is gone`);
    network.setPublicUrl(null);
    events.broadcast('tunnel', { publicUrl: null });

    scheduleRetry(config, provider, port);
  });
}

function scheduleRetry(config, provider, port) {
  if (stopped) return;

  console.log(`[tunnel] retrying in ${Math.round(retry / 1000)}s`);
  const timer = setTimeout(() => launch(config, provider, port), retry);
  timer.unref?.();

  retry = Math.min(retry * 2, MAX_RETRY_MS);
}

function stop() {
  stopped = true;
  if (child) {
    child.kill();
    child = null;
  }
}

module.exports = { start, stop, providers: Object.keys(PROVIDERS) };
