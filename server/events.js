/**
 * Server-Sent Events: how the three screens stay in step.
 *
 * The scanner produces results, the display shows them, the QR page offers the
 * recording for download. SSE is a good fit - the traffic is entirely
 * server-to-client, it reconnects on its own, and it needs no dependency.
 */

/** @type {Set<import('express').Response>} */
const clients = new Set();

// Browsers and proxies drop a quiet connection; a comment line keeps it warm.
const HEARTBEAT_MS = 20000;

/**
 * Registers an SSE client and keeps the connection open until it disconnects.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write('retry: 2000\n\n');
  clients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* the close handler below will clean up */
    }
  }, HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

/**
 * Sends an event to every connected screen. A dead connection is dropped
 * rather than allowed to throw.
 *
 * @param {string} type
 * @param {object} payload
 */
function broadcast(type, payload = {}) {
  const frame = `data: ${JSON.stringify({ type, ...payload })}\n\n`;

  clients.forEach((res) => {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  });
}

function clientCount() {
  return clients.size;
}

module.exports = { addClient, broadcast, clientCount };
