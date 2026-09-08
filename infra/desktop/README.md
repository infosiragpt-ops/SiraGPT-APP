# sira-desktop (F7.2)

Isolated X desktop image for SiraComputer. **Does not replace** the live
computer orchestrator from PR #484.

```bash
docker build -t sira-desktop:latest infra/desktop
docker run -d --name sira-desk-f72 sira-desktop:latest
docker exec sira-desk-f72 python3 -c \
  "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:9000/health').read().decode())"
```

| Surface | Bind | Notes |
|---|---|---|
| DCP (health, screenshot, click/type/key/scroll, launch/navigate/exec, file, cursor, input_mode, mask) | `127.0.0.1:9000` | loopback only |
| Xvfb | `:0` | 1280×720 |
| x11vnc | `127.0.0.1:5900` | loopback only |
| noVNC / websockify | `127.0.0.1:6080` | backend WS proxy in F7.2; not published |

`/workspace/.desktop_ready` is created only after DCP health is 200.

`POST /input_mode` `{mode:"human"}` locks agent actions with **423**.

User `sira` is created by name — never `useradd -u 1000` (PR #485).
