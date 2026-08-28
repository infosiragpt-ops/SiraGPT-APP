# sira-desktop (F7.0)

Isolated X desktop image for SiraComputer. **Does not replace** the live
`siragpt-computer-orchestrator` from PR #484.

```bash
docker build -t sira-desktop:latest infra/desktop
docker run -d --name sira-desk-f70 sira-desktop:latest
docker exec sira-desk-f70 python3 -c \
  "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:9000/health').read().decode())"
```

| Surface | Bind | Notes |
|---|---|---|
| DCP `/health`, `/screenshot` | `127.0.0.1:9000` | required F7.0 gate |
| Xvfb | `:0` | 1280×720 |
| x11vnc | `127.0.0.1:5900` | loopback only in F7.0 |
| noVNC / websockify | `127.0.0.1:6080` | WS proxy is a later phase |

`/workspace/.desktop_ready` is created only after DCP health is 200.

User `sira` is created by name — never `useradd -u 1000` (PR #485).
