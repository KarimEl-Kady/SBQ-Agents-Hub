# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SBQ Agents Hub is a local-first orchestrator that runs official coding CLIs (`claude`, `codex`, `agy` (Antigravity), `opencode`, `gemini`, `kilo`) as stages in a configurable multi-agent workflow (Plan → Implement → Review/FIX loop → Support → Final Review → Release prep). It ships as an Electron desktop app and a VS Code sidebar extension, and both share one Node.js engine. Plain JavaScript (ESM `.mjs` for the engine and scripts, CJS for Electron/VS Code). There is no build step, no TypeScript, no linter and no test framework. Node 22 is what CI uses.

## Commands

```bash
npm install
npm run check            # node --check syntax pass over engine/desktop/extension/UI files
npm run test:all         # all 16 offline suites in sequence (scripts/run-all-tests.mjs), stops on first failure
node scripts/test-codex-bridge.mjs   # run a single suite directly (each also has an npm alias, e.g. npm run test:codex)
npm run engine           # start the engine standalone (needed by the VS Code extension during dev)
npm run desktop          # scripts/desktop.mjs: Linux Electron-sandbox check, then Electron (reuses a running engine or starts one in-process)
npm run sync:extension   # copy packages/ui into apps/vscode/media and packages/engine into apps/vscode/engine (gitignored)
npm run test:setup       # parsers/flags for real CLI output (agy, OpenCode, Codex network, Claude plan files)
npm run extension:package
npm run dist:linux       # electron-builder; also dist:win, dist:mac
npm run doctor:linux     # Node, Electron SUID sandbox, Codex bwrap/AppArmor, CLI sign-ins (scripts/linux-checks.mjs; also runs as a postinstall hint)
npm run doctor:project -- <path> [--network]
```

CI (`.github/workflows/release.yml`) runs `npm run check` on every OS, but runs `test:all` only on Linux. The test scripts use POSIX shebang shims.

## Architecture

```
Electron renderer --contextBridge/IPC--> apps/desktop/main.cjs --+
                                                                 |  loopback HTTP + bearer token
VS Code webview --postMessage--> apps/vscode/extension.js -------+--> packages/engine/server.mjs --> spawn official CLIs
```

- **Engine (`packages/engine/server.mjs`)**: most of the logic lives in this one file: the HTTP API, provider checks, preflight, CLI command construction (`makeCommand`), output parsing, the workflow state machine (`executeWorkflow`) and run persistence. Helpers: `models.mjs` (model catalog and validation per agent), `workspace.mjs` (SHA-256 file snapshots and diffs, works without Git), `git.mjs`, `project-readiness.mjs` (Node dependency gate). Importing `server.mjs` does not start a server (there is a guard at the bottom), so tests import its exported pure functions directly.
- **Auth boundary**: `startEngine()` binds `127.0.0.1` on a random port and writes `{port, token, pid}` to `~/.sbq-agents-hub/daemon.json` (mode 0600). The renderer and webview never see the token. Only Electron main or the extension host attach it. Both bridges validate routes with the same allowlist regex and allowed query keys (`agent`, `cwd`, `file`, `refresh`). That allowlist is duplicated in `main.cjs` and `extension.js`, so a new API query parameter must be added to both.
- **Engine reuse**: the desktop app pings an existing daemon and refuses to start if its version doesn't match the hard-coded version string. The VS Code extension uses a healthy running daemon, otherwise it imports and starts its bundled copy in `apps/vscode/engine/`.
- **CLI discovery**: `includeCommonCliPaths()` in the engine (called by `startEngine`) merges the login-shell PATH and common per-user bin folders, because GUI and extension-host launches get a minimal PATH. Set `SBQ_SKIP_PATH_DISCOVERY=1` to disable.
- **UI**: `packages/ui/` is the single source (vanilla JS IIFE). `app.js` detects `window.sbqDesktop` (Electron) or `acquireVsCodeApi` (VS Code) to pick the transport. `apps/vscode/media/{index.html,app.css,app.js,assets/*.svg}` are **generated copies**. Edit `packages/ui` and then run `npm run sync:extension`.
- **Local state** lives in `~/.sbq-agents-hub/`: `workflow.json` (stage config), `runs/<id>.json` (history), `run-artifacts/` (full stage outputs), `antigravity-connection.json`. Nothing is ever auto-resumed. Live continuations sit in the in-memory `continuations` map, and a serializable copy is saved as `run.resume` (at each stage start, on recovery pauses and on planning questions). On restart `restoreAfterRestart` turns an unfinished run into `needs-attention` with `pendingRecovery.code = 'INTERRUPTED'` (or restores `needs-input`), so the user can retry only that stage through `POST /api/runs/:id/retry-stage` with `confirmNewModelCall: true`. Runs without `run.resume` (older history) just become `interrupted`.

### Workflow / stage contract

- Each stage has a `role` (`plan`, `implement`, `review`, `support`, `release`), an `agent`, `modelMode` (`default` or a catalog model), `effort`, and optionally `requireChanges`, `reviewLoop`, `returnTo`, `maxRetries`, `verifyCommand` and `allowNetwork`. Only `implement` and `support` are writable. `makeCommand` maps that to each CLI's own read-only/edit flags (Claude `--permission-mode plan|acceptEdits`, Codex `--sandbox read-only|workspace-write` with the prompt sent on **stdin** via `-`, etc.). `stageAllowsInstalls(s)` (writable role and `allowNetwork !== false`) adds `-c sandbox_workspace_write.network_access=true --add-dir ~/.sbq-agents-hub/agent-cache` plus package-cache env vars for Codex, and `Bash(npm install)` etc. for Claude. The dependency preflight only blocks a run when no stage may install.
- Agents report back through text markers that the engine parses: `SBQ_STAGE_STATUS: COMPLETE|PARTIAL|BLOCKED|SKIPPED` and, for review stages, a final standalone `SBQ_REVIEW_VERDICT: PASS|FIX`. FIX jumps back to `returnTo` with a bounded retry count. A missing or ambiguous verdict stops the run.
- **Fail-closed rules**: a CLI exit code of 0 is never enough on its own. Write stages must produce observed file changes (workspace snapshots before and after). Read-only stages that modify files are blocked. Explicit PARTIAL/BLOCKED halts the run. Preflight (`workflowReadiness`, `codexSandboxPreflight`, provider/login checks, dependency gate) runs before the first paid stage, so a downstream problem blocks the run before any planning tokens are spent.
- Claude in plan mode often writes the full plan to `~/.claude/plans/*.md` and replies with a summary. `claudePlanFromOutput` reads that file (only inside that folder, only if written during the stage) and uses it as the plan.
- The architect plan is saved as an artifact, and a bounded head+tail excerpt (`contextualExcerpt`, `MAX_CONTEXT_CHARS`) is passed to later stages and FIX retries.

### Safety invariants (do not regress)

Never add `--dangerously-skip-permissions`, unrestricted `Bash`, or blanket sandbox bypasses. Never read or copy provider credentials (login always goes through the official CLI command in `LOGIN_COMMANDS`, opened in a terminal). Never auto-commit, push or deploy. Tool approvals must stay narrow: see `SAFE_COMMAND`, `PREAPPROVED_CHECKS` and `suggestedToolPermission`, which reject paths outside the workspace and `.env` files. Never automatically re-run expensive stages without explicit user confirmation.

## Tests

Each `scripts/test-*.mjs` (18 suites) is a standalone `node:assert` script. The end-to-end suites write a fake multi-agent CLI (one Node script written out as `claude`, `codex`, `agy`, `opencode`) into a temp `bin/`, spawn `server.mjs` with `HOME` set to a temp dir and that `bin/` first on `PATH`, read the temp `daemon.json`, and drive the HTTP API. No real provider calls are made. The fake CLIs must emit each provider's real stream-JSON shape (see `scripts/test-orchestration-contract.mjs`). A new suite must be added to the `files` list in `scripts/run-all-tests.mjs` (90 s timeout per suite).

## Conventions

- Existing code uses a very dense style with many statements on one line. Match the surrounding style instead of reformatting whole files.
- A new engine/desktop/extension source file must be added to the `check` script in `package.json`, and to `build.files` if it is in a new directory. Model-catalog and auth parsers must be tested against the CLI's real output format (for example, `agy models` separates columns with tabs).
- **Version bumps**: change only the root `package.json`. The engine, the desktop version check and the tests read it, and `npm run sync:extension` copies it into `apps/vscode/package.json`. The README and `docs/verification-matrix.md` headers are edited by hand.
- The README is a running release log (newest release at the top). `docs/verification-matrix.md` lists the manual checks that the offline suite does not cover.
