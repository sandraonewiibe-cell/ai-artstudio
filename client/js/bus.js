/**
 * Live channel between the three screens.
 *
 * EventSource reconnects on its own, which is what an all-day exhibition
 * wants: a display that briefly loses the server picks straight back up
 * without anyone touching it.
 */

/**
 * @param {(event: object) => void} onEvent
 * @param {{onOpen?: () => void, onDown?: () => void}} handlers
 * @returns {EventSource}
 */
export function connect(onEvent, handlers = {}) {
  const source = new EventSource('/api/events');

  source.onopen = () => {
    console.log('[bus] connected');
    if (handlers.onOpen) handlers.onOpen();
  };

  source.onmessage = (message) => {
    if (!message.data) return;

    try {
      onEvent(JSON.parse(message.data));
    } catch (err) {
      console.warn('[bus] bad event payload:', err.message);
    }
  };

  source.onerror = () => {
    // EventSource retries by itself; this is only for the on-screen notice.
    if (handlers.onDown) handlers.onDown();
  };

  return source;
}
