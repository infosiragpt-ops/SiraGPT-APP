#!/usr/bin/env python3
"""SiraGPT CEO desktop control: open apps + pointer/keyboard via XTEST."""
from __future__ import annotations

import os
import subprocess
import sys
import time
from ctypes import CDLL, c_char_p, c_int, c_uint, c_ulong, c_void_p

os.environ.setdefault("DISPLAY", ":1")
os.environ.setdefault("HOME", "/config")

SHIFT_MAP = {
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
    "*": "8", "(": "9", ")": "0", "_": "minus", "+": "equal", "{": "bracketleft",
    "}": "bracketright", "|": "backslash", ":": "semicolon", '"': "apostrophe",
    "<": "comma", ">": "period", "?": "slash", "~": "grave",
}
PLAIN_MAP = {
    " ": "space", "\n": "Return", "\r": "Return", "\t": "Tab",
    "-": "minus", "=": "equal", "[": "bracketleft", "]": "bracketright",
    "\\": "backslash", ";": "semicolon", "'": "apostrophe", ",": "comma",
    ".": "period", "/": "slash", "`": "grave",
}
NAMED_KEYS = {
    "return": "Return", "enter": "Return", "backspace": "BackSpace",
    "tab": "Tab", "escape": "Escape", "esc": "Escape",
    "left": "Left", "right": "Right", "up": "Up", "down": "Down",
    "space": "space", "f5": "F5", "home": "Home", "end": "End",
    "delete": "Delete", "super": "Super_L",
    "t": "t", "l": "l", "w": "w", "r": "r",
}


def run(cmd: str, timeout: int = 20) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-lc", cmd],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def alive(pattern: str) -> bool:
    return run("pgrep -f %s >/dev/null" % pattern).returncode == 0


def display_size() -> tuple[int, int]:
    try:
        xlib = CDLL("libX11.so.6")
        xlib.XOpenDisplay.argtypes = [c_char_p]
        xlib.XOpenDisplay.restype = c_void_p
        xlib.XDisplayWidth.argtypes = [c_void_p, c_int]
        xlib.XDisplayWidth.restype = c_int
        xlib.XDisplayHeight.argtypes = [c_void_p, c_int]
        xlib.XDisplayHeight.restype = c_int
        xlib.XCloseDisplay.argtypes = [c_void_p]
        dpy = xlib.XOpenDisplay(None)
        if not dpy:
            return 1024, 768
        w = int(xlib.XDisplayWidth(dpy, 0) or 1024)
        h = int(xlib.XDisplayHeight(dpy, 0) or 768)
        xlib.XCloseDisplay(dpy)
        return max(320, w), max(240, h)
    except Exception:
        return 1024, 768


class Display:
    def __init__(self) -> None:
        self.xlib = CDLL("libX11.so.6")
        self.xtst = CDLL("libXtst.so.6")
        self.xlib.XOpenDisplay.argtypes = [c_char_p]
        self.xlib.XOpenDisplay.restype = c_void_p
        self.xlib.XCloseDisplay.argtypes = [c_void_p]
        self.xlib.XFlush.argtypes = [c_void_p]
        self.xlib.XStringToKeysym.argtypes = [c_char_p]
        self.xlib.XStringToKeysym.restype = c_ulong
        self.xlib.XKeysymToKeycode.argtypes = [c_void_p, c_ulong]
        self.xlib.XKeysymToKeycode.restype = c_uint
        self.xtst.XTestFakeMotionEvent.argtypes = [c_void_p, c_int, c_int, c_int, c_ulong]
        self.xtst.XTestFakeButtonEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]
        self.xtst.XTestFakeKeyEvent.argtypes = [c_void_p, c_uint, c_int, c_ulong]
        self.dpy = self.xlib.XOpenDisplay(None)
        if not self.dpy:
            raise SystemExit("NO_DISPLAY")

    def close(self) -> None:
        if self.dpy:
            self.xlib.XCloseDisplay(self.dpy)
            self.dpy = None

    def flush(self) -> None:
        self.xlib.XFlush(self.dpy)

    def keycode(self, name: str) -> int:
        sym = self.xlib.XStringToKeysym(name.encode("ascii", "ignore"))
        if not sym:
            return 0
        return int(self.xlib.XKeysymToKeycode(self.dpy, sym))

    def tap_code(self, code: int, delay: float = 0.012) -> None:
        if not code:
            return
        self.xtst.XTestFakeKeyEvent(self.dpy, code, 1, 0)
        self.flush()
        time.sleep(delay)
        self.xtst.XTestFakeKeyEvent(self.dpy, code, 0, 0)
        self.flush()

    def tap_named(self, name: str, shift: bool = False) -> None:
        code = self.keycode(name)
        if not code:
            return
        shift_code = self.keycode("Shift_L") if shift else 0
        if shift_code:
            self.xtst.XTestFakeKeyEvent(self.dpy, shift_code, 1, 0)
            self.flush()
        self.tap_code(code)
        if shift_code:
            self.xtst.XTestFakeKeyEvent(self.dpy, shift_code, 0, 0)
            self.flush()


def click(x: int, y: int, button: int = 1) -> None:
    d = Display()
    d.xtst.XTestFakeMotionEvent(d.dpy, -1, int(x), int(y), 0)
    d.flush()
    time.sleep(0.02)
    d.xtst.XTestFakeButtonEvent(d.dpy, int(button), 1, 0)
    d.xtst.XTestFakeButtonEvent(d.dpy, int(button), 0, 0)
    d.flush()
    d.close()
    print("CLICK_OK %s %s %s" % (x, y, button))


def scroll(x: int, y: int, dy: int) -> None:
    d = Display()
    d.xtst.XTestFakeMotionEvent(d.dpy, -1, int(x), int(y), 0)
    d.flush()
    button = 4 if int(dy) < 0 else 5
    steps = min(12, max(1, abs(int(dy)) // 40 or 1))
    for _ in range(steps):
        d.xtst.XTestFakeButtonEvent(d.dpy, button, 1, 0)
        d.xtst.XTestFakeButtonEvent(d.dpy, button, 0, 0)
        d.flush()
        time.sleep(0.01)
    d.close()
    print("SCROLL_OK %s %s %s" % (x, y, dy))


def type_text(text: str) -> None:
    d = Display()
    sent = 0
    for ch in text[:2000]:
        if "a" <= ch <= "z" or "0" <= ch <= "9":
            d.tap_named(ch)
            sent += 1
            continue
        if "A" <= ch <= "Z":
            d.tap_named(ch.lower(), shift=True)
            sent += 1
            continue
        if ch in PLAIN_MAP:
            d.tap_named(PLAIN_MAP[ch])
            sent += 1
            continue
        if ch in SHIFT_MAP:
            d.tap_named(SHIFT_MAP[ch], shift=True)
            sent += 1
            continue
    d.close()
    print("TYPE_OK %s" % sent)


def press_key(spec: str) -> None:
    raw = str(spec or "").strip()
    if not raw:
        print("KEY_EMPTY")
        return
    parts = [p for p in raw.lower().replace("+", "-").split("-") if p]
    d = Display()
    mods = []
    key = "Return"
    for part in parts:
        if part in ("ctrl", "control"):
            mods.append("Control_L")
        elif part == "alt":
            mods.append("Alt_L")
        elif part == "shift":
            mods.append("Shift_L")
        elif part == "super":
            mods.append("Super_L")
        else:
            key = NAMED_KEYS.get(part, part[:1].upper() + part[1:] if len(part) > 1 else part)
    codes = [d.keycode(m) for m in mods]
    codes = [c for c in codes if c]
    main = d.keycode(key)
    for code in codes:
        d.xtst.XTestFakeKeyEvent(d.dpy, code, 1, 0)
    d.flush()
    if main:
        d.tap_code(main)
    for code in reversed(codes):
        d.xtst.XTestFakeKeyEvent(d.dpy, code, 0, 0)
    d.flush()
    d.close()
    print("KEY_OK %s" % raw)


def open_chrome(ensure: bool) -> None:
    up = alive("/usr/lib/chromium/chromium")
    if up and ensure:
        print("CHROME_UP")
        return
    if not up:
        run(
            "nohup chromium --no-first-run --disable-dev-shm-usage "
            "--window-size=720,500 --window-position=24,56 --disable-infobars "
            "-- https://www.google.com >>/config/sira-nav.log 2>&1 & echo $! > /config/sira-chrome.pid"
        )
        time.sleep(1.2)
        print("CHROME_STARTED")
        return
    print("CHROME_FOCUS")


def focus_chrome() -> None:
    # Chrome is windowed at 24,56 x 720x500. Click the client area, not the dock.
    click(220, 140, 1)
    time.sleep(0.05)


def new_tab() -> None:
    open_chrome(True)
    time.sleep(0.12)
    focus_chrome()
    press_key("ctrl-t")
    print("NEWTAB_OK")


def search(query: str) -> None:
    q = str(query or "").strip()[:500]
    if not q:
        print("SEARCH_EMPTY")
        return
    new_tab()
    time.sleep(0.22)
    press_key("ctrl-l")
    time.sleep(0.12)
    type_text(q)
    time.sleep(0.06)
    press_key("Return")
    print("SEARCH_OK")


def open_terminal(ensure: bool) -> None:
    up = run("pgrep -x xfce4-terminal >/dev/null").returncode == 0
    if up and ensure:
        print("TERMINAL_UP")
        return
    run(
        "nohup xfce4-terminal --disable-server --geometry=86x22+18+430 "
        "--working-directory=/config --title=Terminal "
        ">>/config/sira-term.log 2>&1 & echo $! > /config/sira-term.pid"
    )
    time.sleep(0.6)
    print("TERMINAL_STARTED" if not up else "TERMINAL_FOCUS")


def open_files(ensure: bool) -> None:
    visible = "thunar-real /" in run("ps -eo args").stdout
    if visible and ensure:
        print("FILES_UP")
        return
    run("nohup thunar /config >>/config/sira-thunar.log 2>&1 & echo $! > /config/sira-thunar.pid")
    time.sleep(0.6)
    print("FILES_STARTED" if not visible else "FILES_FOCUS")


def unmaximize() -> None:
    try:
        click(360, 220, 1)
        press_key("alt-F5")
        print("UNMAX_OK")
    except Exception as exc:
        print("UNMAX_FAIL %s" % exc)


def status() -> None:
    desktop = alive("xfdesktop") or alive("xfce4-session")
    chrome = alive("/usr/lib/chromium/chromium")
    terminal = run("pgrep -x xfce4-terminal >/dev/null").returncode == 0
    files = "thunar-real /" in run("ps -eo args").stdout or run("pgrep -c -f thunar-real").stdout.strip() not in ("", "0", "1")
    w, h = display_size()
    print("DESKTOP=%s" % int(bool(desktop)))
    print("CHROME=%s" % int(bool(chrome)))
    print("TERMINAL=%s" % int(bool(terminal)))
    print("FILES=%s" % int(bool(files)))
    print("DISPLAY=%sx%s" % (w, h))
    print("STATUS_OK")


def grok_layout() -> None:
    import os
    script = "/config/sira-grok-layout.sh"
    if os.path.isfile(script):
        run("bash %s --as-user" % script, timeout=40)
        print("GROK_LAYOUT_RAN")
    else:
        print("GROK_LAYOUT_SKIP")


def prepare() -> None:
    grok_layout()
    open_chrome(True)
    open_terminal(True)
    open_files(True)
    time.sleep(0.4)
    unmaximize()
    status()


def main() -> None:
    args = sys.argv[1:]
    if not args:
        status()
        return
    cmd = args[0]
    if cmd == "status":
        status()
    elif cmd == "prepare":
        prepare()
    elif cmd == "open":
        app = args[1] if len(args) > 1 else "all"
        mode = args[2] if len(args) > 2 else "focus"
        ensure = mode == "ensure"
        if app in ("all", "desktop"):
            prepare() if app == "all" else status()
        elif app in ("chrome", "browser", "navegador"):
            open_chrome(ensure)
        elif app in ("terminal", "term"):
            open_terminal(ensure)
        elif app in ("files", "archivos", "thunar"):
            open_files(ensure)
        else:
            print("UNKNOWN_APP %s" % app)
            raise SystemExit(2)
    elif cmd == "click":
        click(int(args[1]), int(args[2]), int(args[3]) if len(args) > 3 else 1)
    elif cmd == "scroll":
        scroll(int(args[1]), int(args[2]), int(args[3]) if len(args) > 3 else 120)
    elif cmd == "type":
        type_text(" ".join(args[1:]))
    elif cmd == "key":
        press_key(" ".join(args[1:]))
    elif cmd in ("new_tab", "newtab"):
        new_tab()
    elif cmd == "search":
        search(" ".join(args[1:]))
    elif cmd == "unmax":
        unmaximize()
    elif cmd == "layout":
        grok_layout()
    else:
        print("UNKNOWN_CMD %s" % cmd)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
