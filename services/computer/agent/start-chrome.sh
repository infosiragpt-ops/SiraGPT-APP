#!/bin/bash
exec /usr/bin/google-chrome-stable --no-sandbox --disable-dev-shm-usage --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --user-data-dir=/workspace/.chrome --no-first-run --disable-gpu --window-size=1366,768 about:blank
