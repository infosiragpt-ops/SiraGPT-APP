# Linux Agent Integration

SiraGPT supports Linux as a first-class host bridge target for autonomous agent work.

## What Is Enabled

- Platform detection through `host-platform-profile`.
- Linux bridge mode: `local_linux_bridge`.
- URL and folder opening through `xdg-open`.
- Terminal launch through `x-terminal-emulator`.
- Optional VS Code project opening through `code`, with `xdg-open` fallback.
- Screenshot capture through common Linux tools: `gnome-screenshot`, `grim`, `scrot`, or ImageMagick `import`.
- Read-only Linux diagnostics through `host_bash`: `uname`, `lsb_release`, `hostname`, `whoami`, `id`, `uptime`, `free`, `df`, `ps`, and safe `systemctl` status queries.

## Safety Contract

- Shell commands still require explicit confirmation.
- `host_bash` does not allow pipes, redirects, shell chaining, or arbitrary commands.
- File operations stay inside configured SiraGPT workspace roots.
- `systemctl` is read-only only. Start, stop, restart, enable, disable, reload, and edit actions are rejected.
- Secrets, destructive actions, payments, public posting, and production deploy commands remain blocked by policy.

## Linux Doctor

Run:

```bash
bash scripts/linux-bridge-doctor.sh
```

The script reports whether a Linux host has the common bridge tools installed. It does not use `sudo`, does not install packages, and does not change system state.

## Environment

- `SIRAGPT_DESKTOP_BRIDGE_PLATFORM=linux` forces Linux bridge planning when running outside Linux.
- `SIRAGPT_DESKTOP_BRIDGE_ENABLED=1` enables bridge execution.
- `SIRAGPT_DESKTOP_BRIDGE_TOKEN` must be configured before execution.
- `SIRAGPT_PROJECT_ROOT` can override the default project path exposed in bridge capabilities.
