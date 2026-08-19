# Replit integration

This repo is configured to run inside Replit (`.replit` + `replit.nix`)
and to mirror every commit to your Replit project alongside GitHub.

Replit URL: **https://replit.com/@JorgeCarrera4/SiraGPT-Enhancer**

---

## 🚀 First-time copy into Replit — pick the path that suits you

### Path A — one-click browser import (easiest, 10 seconds)

While signed into Replit, open:

> **<https://replit.com/github/SiraGPT-ORg/siraGPT>**

Replit imports the repo, reads `.replit` + `replit.nix`, and shows the
**Run** button. Click it and the dev server boots. No terminal commands
needed.

### Path B — paste-and-run inside the Replit terminal

Open the Replit terminal (`~/workspace$`) and paste **this one line**:

```bash
curl -fsSL https://raw.githubusercontent.com/SiraGPT-ORg/siraGPT/main/scripts/replit-bootstrap.sh | bash
```

It runs `git clone`-equivalent + `npm ci` + `prisma generate`, seeds
`.env` from `.env.example`, and prints the next steps. Equivalent to
Path A but driven from a shell.

### Path C — let me push from my machine

If you'd rather not touch Replit at all, share a Replit
personal-access token (from
<https://replit.com/account#personal-access-tokens>, Read+Write scope).
Then I can run `git remote add replit <token-url>` and
`./scripts/push-all.sh main` from this terminal — code lands in your
repl with zero clicks on your end. The token only stays in this
session and never gets committed.

---

## What's wired up

| File                                | Purpose                                                                |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `.replit`                           | Tells Replit which language modules to load and which command to run.  |
| `replit.nix`                        | System dependencies (Node 20, Tesseract for OCR, libvips for `sharp`). |
| `scripts/replit-bootstrap.sh`       | The one-liner above. Clones from GitHub + `npm ci` + Prisma + seeds .env. |
| `scripts/push-all.sh`               | Local helper: pushes the current branch to **GitHub + Replit** in parallel. |
| `.github/workflows/replit-sync.yml` | CI mirror — every commit on `main` is force-pushed to Replit.          |

The CI mirror is the recommended path: it runs without local setup
and keeps Replit in sync even when commits arrive from other devices.
The local `push-all.sh` is the manual escape hatch.

---

## One-time setup (CI mirror — recommended)

1. **Get a Replit personal-access token.** Open
   <https://replit.com/account#personal-access-tokens> and create a
   token with **Read + Write** scope on this repl. Save it somewhere
   safe — Replit only shows it once.

2. **Get the Replit git URL.** Open the repl in the Replit IDE →
   sidebar **Version Control** → **Connect with Git** → copy the
   `https://...replit.com/repls/<id>.git` URL it shows. (No token in
   that URL — the workflow injects it.)

3. **Add two GitHub Actions secrets** to
   <https://github.com/SiraGPT-ORg/siraGPT/settings/secrets/actions>:

   | Name                | Value                                       |
   | ------------------- | ------------------------------------------- |
   | `REPLIT_REMOTE_URL` | the git URL from step 2                     |
   | `REPLIT_TOKEN`      | the personal-access token from step 1       |

4. Done. The next push to `main` triggers
   `.github/workflows/replit-sync.yml`, which mirrors the commit to
   Replit. The repl will show "Pulling…" briefly and then update.

---

## Local push (parallel, manual)

If you prefer to push from your laptop directly to both remotes:

```bash
# one-time: add the Replit remote
git remote add replit https://<your-replit-user>:<token>@replit.com/repls/<repl-id>.git

# every push thereafter:
./scripts/push-all.sh                # current branch
./scripts/push-all.sh main           # specific branch
./scripts/push-all.sh main --force   # force-push to both
```

The script runs both pushes in parallel and reports per-remote
status; it exits non-zero if either side fails so pre-push hooks
notice.

If the `replit` remote is missing the script falls back to a
GitHub-only push, so adding this script to a fork without the remote
is safe.

---

## Running the frontend inside Replit

When you click ▶ **Run** in the Replit IDE, `.replit` invokes
`npm run dev`, which serves Next.js on `localhost:3000`. Replit's
port forwarder maps that to public port `80` (HTTPS), so the
preview URL the IDE surfaces is the real running app.

The Express backend (`backend/`) does **not** run on Replit by
default — it's expected to live on Railway/Fly/Render in production
and on your laptop for local dev. The frontend reads the backend
URL from `NEXT_PUBLIC_API_URL`; set this in Replit's **Secrets**
panel to point at wherever your backend is running.

For a full local stack inside Replit (frontend + backend together):

```toml
# add this block at the end of .replit to override the run command
run = "concurrently \"npm run dev\" \"npm --prefix backend run dev\""
```

(and `npm i -D concurrently` first).

---

## Troubleshooting

**`scripts/push-all.sh` says "no 'replit' remote configured"**
You haven't run `git remote add replit <url>` yet. The script
still pushes to GitHub; add the Replit remote when you want the
parallel push.

**Workflow says "Replit secrets not configured — skipping mirror"**
The two GitHub Actions secrets aren't set on this repo. Follow
"One-time setup" above. The workflow is a no-op without them, so
your `main` pushes are not blocked.

**Replit IDE shows the wrong code**
Inside the Replit IDE, click the Git icon → **Pull** to refresh from
the configured remote. If the IDE shows merge conflicts after a
force-push, click **Reset to remote** to discard the local Replit
changes (they're already on GitHub).

**Backend code is not running on Replit**
By design — see "Running the frontend inside Replit" above. Run the
backend on a host that supports long-lived processes (Railway/Fly).
