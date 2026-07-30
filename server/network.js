const os = require('os');

/**
 * Working out which address to put in the QR code.
 *
 * This matters because a phone scanning the code is a different device: it
 * cannot reach `localhost`, and on a machine with more than one network it can
 * only reach the address on *its own* network.
 *
 * A kiosk PC often has both Ethernet and Wi-Fi live, and both routers hand out
 * 192.168.1.x, so the two addresses look interchangeable and are not. Wi-Fi is
 * preferred because that is where the phone is.
 *
 * Set PUBLIC_HOST to override - which is what you want behind a tunnel, or when
 * the machine's Wi-Fi is not the network visitors are on.
 */

/** Adapters that exist for something other than talking to the local network. */
const VIRTUAL = /vEthernet|WSL|Docker|VirtualBox|VMware|Hyper-V|Loopback|Bluetooth|TAP|Tailscale|ZeroTier/i;

/** Wireless adapters, where a visitor's phone almost certainly is. */
const WIRELESS = /Wi-?Fi|Wireless|WLAN/i;

/**
 * Every address a phone could plausibly reach, best first.
 *
 * @returns {{address: string, interface: string, wireless: boolean}[]}
 */
function candidates() {
  const interfaces = os.networkInterfaces();
  const found = [];

  Object.entries(interfaces).forEach(([name, addresses]) => {
    (addresses || []).forEach((entry) => {
      if (entry.family !== 'IPv4' || entry.internal) return;

      // 169.254.x.x means the adapter asked for a lease and never got one. It
      // is plugged in but on no network, and nothing can reach it.
      if (entry.address.startsWith('169.254.')) return;

      if (VIRTUAL.test(name)) return;

      found.push({
        address: entry.address,
        interface: name,
        wireless: WIRELESS.test(name),
      });
    });
  });

  // Wireless first: the phone is on Wi-Fi, so an address on the wired network
  // may be a different network entirely even when the numbers look similar.
  return found.sort((a, b) => Number(b.wireless) - Number(a.wireless));
}

/**
 * The address to advertise.
 * @returns {string|null}
 */
function lanAddress() {
  if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;

  const best = candidates()[0];
  return best ? best.address : null;
}

/**
 * A publicly reachable base URL, when one exists.
 *
 * A LAN address only works for a phone on the same network. For a phone on
 * mobile data the traffic has to come in from outside, which means a tunnel.
 * Set at runtime by tunnel.js, or up front with PUBLIC_URL.
 *
 * @type {string|null}
 */
let publicUrl = process.env.PUBLIC_URL || null;

function setPublicUrl(url) {
  publicUrl = url ? url.replace(/\/+$/, '') : null;
  return publicUrl;
}

function getPublicUrl() {
  return publicUrl;
}

/**
 * The address this server is reachable at from outside, stated up front.
 *
 * Behind a host's router the process has no way to work this out for itself:
 * it sees a container's private address and an arbitrary internal port, neither
 * of which appears in the URL a visitor types. So it has to be told.
 *
 * Read once at startup - it is fixed for the life of the deployment, unlike a
 * tunnel address, which can change while the kiosk is running.
 *
 * @type {string|null}
 */
const configuredBase = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '') || null;

/**
 * Base URL to hand to a phone.
 *
 * PUBLIC_BASE_URL wins outright: it is the one address that was stated rather
 * than guessed, so nothing detected should override it. Failing that the tunnel
 * wins over the LAN, because it works from any network. The LAN address is the
 * last fallback and only reaches phones on the same wifi.
 *
 * Unset PUBLIC_BASE_URL - which is the normal case locally - and this behaves
 * exactly as it did before.
 *
 * @param {number} port
 */
function publicBase(port) {
  if (configuredBase) return configuredBase;
  if (publicUrl) return publicUrl;

  const host = lanAddress();
  return `http://${host || 'localhost'}:${port}`;
}

/** True if the hostname belongs to this machine rather than the outside world. */
function isLocalHostname(hostname) {
  if (!hostname) return false;

  const name = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name.startsWith('127.') || name === '::1') return true;

  return candidates().some((c) => c.address === name);
}

module.exports = {
  lanAddress,
  publicBase,
  candidates,
  setPublicUrl,
  getPublicUrl,
  isLocalHostname,
};
