'use strict';

/**
 * Visible Chromium inside the agent desktop (Docker).
 * Keep --no-sandbox (required in the container). --test-type suppresses the
 * "unsupported command-line flag" infobar without removing no-sandbox.
 */

const { desktopAppFocusCommand } = require('./desktop-app-focus');

// The desktop boots Chrome with its DevTools port (start-desktop.sh); the
// integrated browser, navigation and tab controls all reach Chrome through
// that port. A relaunch WITHOUT it (user closed Chrome, crash under load)
// used to leave CDP dead until the container restarted: every 4-second
// browser poll answered 502 (prod 2026-10-03, 346 lines in one afternoon).
// Chrome ignores the flag when it hands the launch to a running instance.
const CHROME_CDP_FLAGS = '--remote-debugging-port=9222 --remote-debugging-address=0.0.0.0';

const CHROME_DOCKER_FLAGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--disable-session-crashed-bubble',
  '--hide-crash-restore-bubble',
  '--disable-infobars',
  '--test-type',
  CHROME_CDP_FLAGS,
  '--user-data-dir=/workspace/.chrome',
].join(' ');

const CHROME_WINDOW_FLAGS = '--start-maximized --window-size=1920,1080 --window-position=0,0';
const CHROME_VISIBLE_FLAGS = `${CHROME_DOCKER_FLAGS} ${CHROME_WINDOW_FLAGS}`;

function chromeOpenUrlCommand(url) {
  const quoted = JSON.stringify(String(url || '').trim());
  return `(google-chrome ${CHROME_VISIBLE_FLAGS} --new-window ${quoted} || chromium ${CHROME_VISIBLE_FLAGS} --new-window ${quoted} || xdg-open ${quoted}) >/tmp/sira-nav.log 2>&1 & echo Opening`;
}

function chromeMaximizeOrLaunch({ xdotool = 'xdotool' } = {}) {
  return desktopAppFocusCommand({
    xdotool,
    windowClass: 'google-chrome|Chromium|chromium',
    launchCommand: `if command -v google-chrome >/dev/null 2>&1; then exec google-chrome ${CHROME_VISIBLE_FLAGS}; else exec chromium ${CHROME_VISIBLE_FLAGS}; fi`,
    maximize: true,
  });
}

module.exports = {
  CHROME_CDP_FLAGS,
  CHROME_DOCKER_FLAGS,
  CHROME_WINDOW_FLAGS,
  CHROME_VISIBLE_FLAGS,
  chromeOpenUrlCommand,
  chromeMaximizeOrLaunch,
};
