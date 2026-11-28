const http = require('http');
const { execFile } = require('child_process');

/**
 * What to do when `npm start` finds its port already taken.
 *
 * Nearly always the answer is that the studio is already running - an earlier
 * `npm start` in another window, left open. Starting again is someone wanting a
 * fresh server, usually to pick up a change, and having to find the old window
 * to stop it first is exactly the step that gets missed. So if what holds the
 * port is this studio, it is stopped and this one takes its place. If it is
 * anything else, it is left alone and the message says what is in the way.
 */

/** Asks whatever is on the port whether it is the studio. */
function isStudio(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body).app === 'AI ART STUDIO');
        } catch {
          resolve(false);
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

/** The process ids listening on a port, other than this one. */
function listeners(port) {
  return new Promise((resolve) => {
    const done = (ids) => resolve([...new Set(ids)].filter((id) => id && id !== process.pid));

    if (process.platform === 'win32') {
      execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true }, (err, stdout) => {
        if (err) return done([]);
        const ids = stdout
          .split(/\r?\n/)
          .map((line) => line.trim().split(/\s+/))
          .filter((cols) => cols.length >= 5 && /LISTENING/i.test(cols[3]) && cols[1].endsWith(`:${port}`))
          .map((cols) => Number(cols[4]));
        return done(ids);
      });
      return;
    }

    execFile('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], (err, stdout) => {
      if (err) return done([]);
      return done(stdout.split(/\s+/).map(Number));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Frees the port if an older studio holds it.
 *
 * @returns {Promise<'replaced'|'not-studio'|'could-not'>}
 */
async function takeOver(port) {
  if (!(await isStudio(port))) return 'not-studio';

  const ids = await listeners(port);
  if (!ids.length) return 'could-not';

  for (const id of ids) {
    try {
      process.kill(id);
      console.log(`[server] stopped the studio that was already running (process ${id})`);
    } catch (err) {
      console.warn(`[server] could not stop process ${id}: ${err.message}`);
    }
  }

  // Wait for the port to come free.
  for (let i = 0; i < 25; i += 1) {
    await sleep(200);
    if (!(await listeners(port)).length) return 'replaced';
  }
  return 'could-not';
}

module.exports = { takeOver };
