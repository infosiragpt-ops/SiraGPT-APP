#!/usr/bin/env bash
#
# smoke-agentic-core.sh — end-to-end local verification of the 6
# agentic-core patterns (skills registry, policy, planner, scheduler,
# sessions, API keys).
#
# Prereqs:
#   - Backend running on localhost:5000 (cd backend && npm run dev)
#   - A valid OPENAI_API_KEY in backend/.env if you want the LLM-driven
#     patterns (2 mode-run, 3 thinking) to produce real answers. The
#     infrastructure-only checks work even with an invalid key.
#
# Usage:
#   ./backend/scripts/smoke-agentic-core.sh
#
set -euo pipefail

BASE="${BASE:-http://localhost:5000}"
EMAIL="${EMAIL:-agent-smoke-$(date +%s)@local.test}"
PASS="${PASS:-smoke-pass-123}"

say() { printf '\n=== %s ===\n' "$*"; }

# ─── Health ───────────────────────────────────────────────────────────────
say "Health"
curl -sf "$BASE/health" | python3 -m json.tool

# ─── Auth ─────────────────────────────────────────────────────────────────
say "Register smoke user"
REG=$(curl -sf -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Agent Smoke\",\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
TOKEN=$(echo "$REG" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
echo "JWT stored (hidden)."

# ─── Pattern 1 — Skills registry ──────────────────────────────────────────
say "Pattern 1 — GET /api/agent/skills"
curl -sf "$BASE/api/agent/skills" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('loaded:', len(d['skills']), 'skills'); [print(' -', s['id']) for s in d['skills']]"

# ─── Pattern 6 — Mint + pair an API key ───────────────────────────────────
say "Pattern 6 — mint agent key (scope: sandbox, only web_search+rag_retrieve)"
KEY=$(curl -sf -X POST "$BASE/api/agent/keys" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"label":"smoke-cli","scope":{"mode":"sandbox","skillIds":["web_search","rag_retrieve"],"maxCalls":20}}')
KEY_ID=$(echo "$KEY" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SECRET=$(echo "$KEY" | python3 -c "import json,sys;print(json.load(sys.stdin)['secret'])")
echo "key id: $KEY_ID"

say "Pattern 6 — first use from unseen principal → 428 + pair code"
PAIR=$(curl -s -X POST "$BASE/api/agent/run" \
  -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' \
  -d '{"query":"hi","useSkills":true}' | tee /dev/stderr)
CODE=$(echo "$PAIR" | python3 -c "import json,sys;print(json.load(sys.stdin).get('pairingCode',''))")
echo "pair code: $CODE"

say "Pattern 6 — owner approves the pair code"
curl -sf -X POST "$BASE/api/agent/keys/$KEY_ID/pair/$CODE" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# ─── Pattern 2 — policy hides un-granted skills ───────────────────────────
say "Pattern 2 — run with mode:sandbox; SSE should emit a 'policy' frame listing hidden skills"
curl -sN --max-time 5 -X POST "$BASE/api/agent/run" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"just test","useSkills":true,"mode":"sandbox"}' \
  2>&1 | grep -m1 '"type":"policy"' \
  | python3 -c "import json,sys,re;raw=sys.stdin.read();m=re.search(r'data: (.+)$',raw);print(json.dumps(json.loads(m.group(1)),indent=2))" || true

# ─── Pattern 3 — run with thinking=medium (needs a valid OPENAI_API_KEY) ──
say "Pattern 3 — thinking=medium (requires valid OPENAI_API_KEY; will stream plan/step/synthesis/final)"
curl -sN --max-time 90 -X POST "$BASE/api/agent/run" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"What is 12 * 17? Respond in one sentence.","useSkills":true,"thinking":"medium"}' \
  2>&1 | grep -E '^data: ' | head -20 || true

# ─── Pattern 4 — scheduler CRUD via skill (requires valid OPENAI_API_KEY) ─
# (Skipped here — the cron_schedule skill runs inside the agent's ReAct
# loop, which needs a real LLM call. See README for the direct Node
# exercise you can run without OpenAI.)

# ─── Pattern 5 — list chat sessions after creating chats ──────────────────
say "Pattern 5 — run agent asking 'list my sessions' (requires valid OPENAI_API_KEY)"
curl -sN --max-time 60 -X POST "$BASE/api/agent/run" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"Use session_list to show my chats.","useSkills":true,"skillIds":["session_list"]}' \
  2>&1 | grep -E '^data: ' | head -10 || true

say "Done. If you saw pair_required → approved → policy hidden list, the core stack is wired correctly."
echo "LLM-dependent checks (thinking=medium, session_list call) need a working OPENAI_API_KEY in backend/.env."
