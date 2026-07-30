import { POLL } from './config.js';

/**
 * Thin wrapper over the session endpoints. Generation runs as a job the kiosk
 * polls, so a slow provider cannot hold a request open until it times out.
 */

/**
 * @param {{paper: string, drawing: string|null, layers?: object}} payload data URLs
 * @returns {Promise<{id: string}>}
 */
export async function createSession(payload) {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Server returned ${response.status}`);

  return body;
}

/**
 * Polls until the job finishes, fails, or the client-side timeout is hit.
 *
 * @param {string} id
 * @param {(job: object) => void} onProgress
 * @returns {Promise<object>} the finished job
 */
export async function waitForSession(id, onProgress = () => {}) {
  const deadline = Date.now() + POLL.timeoutMs;
  let interval = POLL.firstMs;

  while (Date.now() < deadline) {
    await sleep(interval);
    interval = Math.min(interval * POLL.backoff, POLL.maxIntervalMs);

    let job;
    try {
      const response = await fetch(`/api/sessions/${id}`);
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      job = await response.json();
    } catch (err) {
      // A blip while the server restarts should not kill the session; keep
      // polling until the deadline.
      console.warn('[api] poll failed:', err.message);
      continue;
    }

    onProgress(job);

    // 'rejected' means the drawing was not a boat - a normal outcome the
    // caller handles, not a failure.
    if (job.status === 'done' || job.status === 'rejected') return job;
    if (job.status === 'error') throw new Error(job.error || 'Generation failed.');
  }

  throw new Error('Generation timed out.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
