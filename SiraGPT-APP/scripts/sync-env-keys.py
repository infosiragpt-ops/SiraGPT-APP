#!/usr/bin/env python3
"""Upsert provider API keys into the project .env from PROD_<NAME> env vars.

Designed to run on the VPS via the sync-provider-keys workflow. Reads
each PROD_<KEY> env var; if set and non-empty, replaces the line in the
target .env file (or appends if absent). Never prints the values — only
the names being updated.

Usage:
    PROD_GROQ_API_KEY=... python3 sync-env-keys.py /path/to/.env
"""
import os
import pathlib
import sys

KEYS = [
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
]


def main(env_path_str: str) -> int:
    env_path = pathlib.Path(env_path_str)
    if not env_path.is_file():
        print(f"ERROR: {env_path} not found", file=sys.stderr)
        return 2

    original = env_path.read_text().splitlines()
    out: list[str] = []
    seen: set[str] = set()

    for line in original:
        replaced = False
        for k in KEYS:
            if line.startswith(k + "="):
                val = os.environ.get("PROD_" + k, "")
                if val:
                    out.append(f"{k}={val}")
                    print(f"  replaced {k}")
                else:
                    out.append(line)
                    print(f"  skip {k} (secret empty, kept existing)")
                seen.add(k)
                replaced = True
                break
        if not replaced:
            out.append(line)

    for k in KEYS:
        if k in seen:
            continue
        val = os.environ.get("PROD_" + k, "")
        if val:
            out.append(f"{k}={val}")
            print(f"  appended {k}")
        else:
            print(f"  skip {k} (not present, secret empty)")

    env_path.write_text("\n".join(out) + "\n")
    print(f"OK wrote {env_path}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: sync-env-keys.py <path-to-env-file>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
