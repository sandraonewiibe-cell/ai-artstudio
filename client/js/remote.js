import { REMOTE } from './config.js';

/**
 * The button that pauses and resumes scanning, whatever it arrives as.
 *
 * The keyboard was the only thing listened to, and only through one property of
 * one event: `event.key === 'a'`. That is enough for a keyboard and is not
 * enough for a bluetooth remote, which is what the kiosk is actually operated
 * with. The little VR remotes used for this are HID devices with several modes,
 * and what a button on one sends depends on which mode it is in:
 *
 *   - as a mouse, which is the mode these remotes are usually left in - the
 *     button is a left click and no key is sent at all;
 *   - as a keyboard, but reporting only a legacy `keyCode` with `key` left as
 *     'Unidentified' - so a test on `key` alone never matches;
 *   - as a keyboard sending some other key entirely, because the button labelled
 *     A is wired to Enter, or to a media key, in that mode;
 *   - as a gamepad, in which case no key event is raised at all and no amount of
 *     listening for one will help.
 *
 * So all four are handled: a left click anywhere pauses, a key is matched on any
 * of the three things a browser might fill in, the list of keys is a setting
 * rather than a constant, and gamepad buttons are watched for directly.
 *
 * Everything that arrives and is *not* recognised is logged, with all of its
 * identifying properties. A remote nobody has in front of them can then be
 * identified from the console in one press, and added to the list without a
 * code change.
 */

/**
 * Starts listening. Returns a function that stops again.
 *
 * @param {() => void} onPress called once per press, however it arrived
 */
export function onPauseRequest(onPress) {
  const stopClicks = watchClicks(onPress);
  const stopKeys = watchKeys(onPress);
  const stopPads = watchGamepads(onPress);

  return () => {
    stopClicks();
    stopKeys();
    stopPads();
  };
}

/**
 * A left click, which is what the remote actually sends.
 *
 * These remotes are usually left in mouse mode, where the button moves a cursor
 * and clicks with it - so nothing arrives as a key at all, whatever the button
 * is labelled, and every amount of listening for a letter was listening for
 * something that was never sent.
 *
 * Anywhere on the screen counts. The scanner has nothing on it to click: no
 * buttons, no fields, nothing to aim at - and a remote in mouse mode leaves its
 * cursor wherever it was last, so requiring a target would mean requiring the
 * operator to aim at something they cannot see. Anything genuinely interactive
 * that is added later is skipped, so this cannot swallow a real control.
 */
function watchClicks(onPress) {
  if (!REMOTE.leftClick) return () => {};

  const handler = (event) => {
    // The primary button only. A right click is a context menu and a middle
    // click is a paste, and neither is somebody asking to pause scanning.
    if (event.button !== 0) {
      if (REMOTE.logInput) console.log(`[remote] ignored click: button=${event.button}`);
      return;
    }

    if (event.target && typeof event.target.closest === 'function' &&
        event.target.closest('button, a, input, select, textarea, [role="button"]')) {
      return;
    }

    console.log('[remote] pause pressed (left click)');
    onPress();
  };

  window.addEventListener('click', handler, true);
  return () => window.removeEventListener('click', handler, true);
}

/**
 * Keys, matched on whatever the browser managed to fill in.
 *
 * On the window rather than the document, and in the capture phase, so nothing
 * further in can swallow the press first.
 */
function watchKeys(onPress) {
  const wanted = REMOTE.pauseKeys.map((k) => String(k).toLowerCase());
  const codes = REMOTE.pauseCodes.map((k) => String(k).toLowerCase());

  const handler = (event) => {
    // Left alone so Ctrl+A and friends still behave normally.
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const key = String(event.key || '').toLowerCase();
    const code = String(event.code || '').toLowerCase();

    const matched =
      wanted.includes(key) ||
      codes.includes(code) ||
      REMOTE.pauseKeyCodes.includes(event.keyCode);

    if (!matched) {
      // The one line that turns "the remote does not work" into a fix: it says
      // exactly what the remote sent, so it can be added to the settings.
      if (REMOTE.logInput) {
        console.log(
          `[remote] ignored key: key=${JSON.stringify(event.key)} ` +
          `code=${JSON.stringify(event.code)} keyCode=${event.keyCode}`
        );
      }
      return;
    }

    event.preventDefault();
    console.log(`[remote] pause pressed (key ${JSON.stringify(event.key)})`);
    onPress();
  };

  window.addEventListener('keydown', handler, true);
  return () => window.removeEventListener('keydown', handler, true);
}

/**
 * Gamepad buttons.
 *
 * A remote presenting itself as a gamepad raises no key events whatsoever, so
 * this is not a nicety - it is the only way such a remote can be heard at all.
 * The buttons are polled, because that is the only way the Gamepad API offers;
 * a press is the edge from up to down, so holding a button does not toggle over
 * and over.
 */
function watchGamepads(onPress) {
  if (!REMOTE.gamepad || typeof navigator === 'undefined' || !navigator.getGamepads) {
    return () => {};
  }

  const held = new Map();
  let running = true;

  const poll = () => {
    if (!running) return;
    requestAnimationFrame(poll);

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];

    for (const pad of pads) {
      if (!pad) continue;

      const before = held.get(pad.index) || [];
      const now = pad.buttons.map((b) => Boolean(b && b.pressed));
      held.set(pad.index, now);

      for (let i = 0; i < now.length; i += 1) {
        if (!now[i] || before[i]) continue;

        // Any button, or only the ones asked for.
        if (REMOTE.gamepadButtons.length && !REMOTE.gamepadButtons.includes(i)) {
          if (REMOTE.logInput) {
            console.log(`[remote] ignored gamepad button ${i} on "${pad.id}"`);
          }
          continue;
        }

        console.log(`[remote] pause pressed (gamepad button ${i} on "${pad.id}")`);
        onPress();
      }
    }
  };

  window.addEventListener('gamepadconnected', (event) => {
    console.log(
      `[remote] gamepad connected: "${event.gamepad.id}" ` +
      `with ${event.gamepad.buttons.length} button(s)`
    );
  });

  requestAnimationFrame(poll);

  return () => {
    running = false;
  };
}
