#!/bin/bash
# Nightly full eval run (launchd: com.modes.eval) — keeps evals/eval-runs.jsonl
# growing unattended. PATH is pinned because launchd agents get a minimal
# environment: kimi/qwen/bun must resolve without a login shell.
set -uo pipefail
export PATH="$HOME/.kimi-code/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

REPO="$HOME/Projects/modes-orchestrator"
cd "$REPO" || exit 1
exec bun packages/orchestrator/scripts/modes-eval.ts --all
