'use strict';

/**
 * Visible Chromium inside the agent desktop (Docker).
 * Keep --no-sandbox (required in the container). --test-type suppresses the
 * "unsupported command-line flag" infobar without removing no-sandbox.
 */

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
  '--user-data-dir=/workspace/.chrome',
].join(' ');

const CHROME_WINDOW_FLAGS = '--start-maximized --window-size=1920,1080 --window-position=0,0';
const CHROME_VISIBLE_FLAGS = `${CHROME_DOCKER_FLAGS} ${CHROME_WINDOW_FLAGS}`;

function chromeOpenUrlCommand(url) {
  const quoted = JSON.stringify(String(url || '').trim());
  return `(google-chrome ${CHROME_VISIBLE_FLAGS} --new-window ${quoted} || chromium ${CHROME_VISIBLE_FLAGS} --new-window ${quoted} || xdg-open ${quoted}) >/tmp/sira-nav.log 2>&1 & echo Opening`;
}

function chromeMaximizeOrLaunch({ xdotool = 'xdotool' } = {}) {
  const xd = String(xdotool || 'xdotool');
  return (
    `${xd} search --onlyvisible --class google-chrome windowactivate --sync windowmove 0 0 windowsize 1920 1080`
    + ` || ${xd} search --onlyvisible --class Chromium windowactivate --sync windowmove 0 0 windowsize 1920 1080`
    + ` || ${xd} search --onlyvisible --class chromium windowactivate --sync windowmove 0 0 windowsize 1920 1080`
    + ` || google-chrome ${CHROME_VISIBLE_FLAGS}`
    + ` || chromium ${CHROME_VISIBLE_FLAGS}`
  );
}

module.exports = {
  CHROME_DOCKER_FLAGS,
  CHROME_WINDOW_FLAGS,
  CHROME_VISIBLE_FLAGS,
  chromeOpenUrlCommand,
  chromeMaximizeOrLaunch,
};
