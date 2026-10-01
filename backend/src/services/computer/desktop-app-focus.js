'use strict';

// Only constant application definitions call this helper. The launch is a
// desktop process, not the lifetime of the HTTP request: detach its streams,
// then acknowledge only a visible window that the window manager activated.
function desktopAppFocusCommand({ windowClass, launchCommand, maximize = false, xdotool = 'xdotool' }) {
  const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
  const xd = quote(xdotool);
  const search = `${xd} search --onlyvisible --limit 1 --class ${quote(windowClass)}`;
  const geometry = maximize
    ? `${xd} windowmove "$window" 0 0 && ${xd} windowsize "$window" 1920 1080 && `
    : '';
  return `window="$(${search} 2>/dev/null)";
if [ -z "$window" ]; then
  (${launchCommand}) </dev/null >/tmp/sira-desktop-app.log 2>&1 &
fi
for attempt in {1..40}; do
  window="$(${search} 2>/dev/null)";
  if [ -n "$window" ] && ${xd} windowactivate "$window" 2>/dev/null; then
    if [ "$(${xd} getactivewindow 2>/dev/null)" = "$window" ]; then
      ${geometry}printf 'desktop_app_ready\\n' && exit 0;
    fi
  fi
  sleep 0.1;
done
printf 'desktop_app_not_ready\\n' >&2;
exit 1`;
}

module.exports = { desktopAppFocusCommand };
