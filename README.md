# SBQ Agents Hub

**The Wise AI Workspace** — a local-first desktop app and VS Code extension for orchestrating your coding CLIs in a chat-first development workflow.

Version: **0.5.1 (developer preview)**. The code and tests are included. The desktop app is based on Electron; the engine is Node.js; both interfaces share the same local engine. This release is not yet a production-hardened autonomous agent system.

## What is new in 0.5.1

- Reworked responsiveness for compact desktop windows and narrow VS Code sidebars.
- Stage settings now open in an accessible dismissible drawer on narrow layouts; clicking a stage opens its settings.
- Added bottom navigation at small widths, flexible chat sizing and scrollable code diffs without page-wide overflow.
- Lowered Electron development window size constraints (400 × 420 minimum), and added `npm run test:responsive`.
- Synced updated HTML/CSS/JS into the VS Code extension.

## What was new in 0.5

- Renamed the project, desktop title, package, and extension to **SBQ Agents Hub** (`sbq-agents-hub`); retained the SBQ gold/teal brand assets.
- Added **Kilo Code CLI** with automatic stages, model selection, live model discovery, and documented **`kilo-auto/free`** routing.
- Added **Freebuff** as an **interactive-only companion** on the Connections page. SBQ can launch it and reuse Freebuff's own login; it does **not** claim that Freebuff supports headless or unattended workflow steps.
- Added one-click **model catalog refresh** from each stage picker, periodic refresh while relevant screens are visible, and refresh on app focus. OpenCode and Kilo use their documented `models --refresh` commands; Codex uses its model-list RPC; other CLI catalogs depend on available CLI APIs. **Claude's documented aliases/IDs and Gemini suggestions aren't entitlement checks or automatic feeds.**
- Added first-run guidance and project onboarding shortcuts. Credentials remain managed by each CLI.
- Added GitHub Actions workflow for separate **Windows, macOS and Linux installable builds**, plus a `.vsix` extension artifact. No `npm install` is required for **end users of built desktop installers**; contributors still install npm dependencies to work from source.
- Shared engine data is now under `~/.sbq-agents-hub/`; an existing `~/.agentflow/workflow.json` is copied once when no new workflow exists. No provider credentials are read or migrated.
- Kept Git diff preview, manual AI review, editable model/stage assignments, streamed progress events, and run cancellation.

## Quickest installation for end users (once CI artifacts are built)

1. Open **GitHub → Actions → “SBQ Agents Hub — Cross-platform release” → Run workflow** (or push a version tag such as `v0.5.0`).
2. When the workflow finishes successfully, download the artifact matching your operating system:

| OS | Files produced by the packaging workflow | Installation |
|---|---|---|
| Windows x64 | `.exe` (NSIS installer) | Run installer; open **SBQ Agents Hub** |
| macOS Intel / Apple Silicon | `.dmg`, `.zip` for each architecture | Install/move app to Applications; approve unsigned preview app if your OS requires |
| Linux | `.AppImage`, `.deb` | Use AppImage (executable permission) or install DEB via package manager |
| VS Code | `.vsix` | **Extensions → ... → Install from VSIX** |

**Important:** This ZIP contains **source code**, not precompiled installers. GitHub Actions builds the installers on the relevant OS runners, and generated artifacts are only available after a successful workflow. The workflow does **not** sign/notarize or automatically publish the binaries; macOS Gatekeeper and Windows SmartScreen may flag unsigned preview builds. Do not bypass security warnings unless you understand and trust the code and build.

**Lightweight setup vs size:** Users of a packaged build do **not** need Node.js or npm to run SBQ. The app still embeds Electron/Chromium, so its installer isn't tiny. A Tauri rewrite would be needed for substantially smaller binaries.

## Developer setup (source code)

Prerequisites: **Node.js 22+**, npm and Git. Install at least one of the supported external agent CLIs for AI execution.

```bash
npm install
npm run setup          # prints CLI/OS diagnostics; never reads credentials
npm run desktop        # opens desktop + starts shared local engine
```

For VS Code extension development, start the engine in one terminal:

```bash
npm run engine
```

Open `apps/vscode` in VS Code and press `F5` to launch Extension Development Host. For a distributable extension:

```bash
npm run extension:package
```

The desktop app automatically starts a shared engine if none is already running. The extension connects to that same engine via a protected localhost token; **start desktop or `npm run engine` before using the extension**. Close any old 0.4 engine before launching 0.5.

## First-run walkthrough

1. Open **Connections** → **Recheck all** to detect already installed CLIs and their permitted status checks.
2. For a missing CLI choose **Install / help** and use its official setup. For an installed CLI choose **Sign in** (or launch its interactive interface); SBQ opens the official login in your terminal and does **not** ask for account passwords or copy keyring credentials.
3. Select **Workflows**, add/reorder/remove stages, give each a purpose, runner, model and instructions; save.
4. Enter an existing repository directory in **Chat**, type a task, and run.
5. Inspect **Code Changes** and request an optional read-only AI code review before committing or pushing.

### Supported agents

| Agent | Automatic stage? | Auth strategy | Model discovery |
|---|---|---|---|
| Claude Code (`claude`) | Yes | Existing `claude` login; `claude auth login` | Documented IDs and aliases; not a live entitlements feed |
| Codex (`codex`) | Yes | Existing ChatGPT/Codex login; `codex login` | Codex app-server `model/list` where available |
| Antigravity (`agy`) | Yes | Official Antigravity IDE/CLI shared session where supported | `agy models` where supported; unverified otherwise |
| OpenCode (`opencode`) | Yes | Existing OpenCode app/CLI provider login; `opencode auth login` | `opencode models --refresh` |
| Gemini CLI (`gemini`) | Yes | Launch Gemini CLI to use its official sign-in | Suggested IDs only; use CLI default if uncertain |
| **Kilo Code** (`kilo`) | **Yes** | Run `kilo` to connect; existing local provider config | `kilo models --refresh` and `kilo-auto/free` |
| **Freebuff** (`freebuff`) | **No — interactive-only** | Launch Freebuff to use its own account | Provider's interactive model picker, not a headless model catalog |

SBQ treats *not installed*, *connected*, *not connected*, and *unverified* differently. A working CLI login is not a guarantee of quota, billing status, or access to every displayed model.

### Free models and privacy

- **Kilo Auto Free**: select **Kilo → `kilo-auto/free`** in the relevant stage. It's a current free-routing option, subject to limits and data-handling conditions. See [Kilo's free usage guide](https://kilo.ai/docs/getting-started/using-kilo-for-free).
- **OpenCode**: supports models from configured providers, including local models through providers such as Ollama; its model list varies by account and configuration. Not every `opencode/...` model is free.
- **Freebuff**: uses free, ad-supported models, but its CLI is interactive only. See [Freebuff](https://github.com/CodebuffAI/freebuff) for availability, region limitations and data-use notices. **Never send confidential repositories to a free provider without reviewing its privacy terms.**
- Other providers' free tiers and local models can be accessed through OpenCode/Kilo when configured; SBQ does not embed or download model weights.

### Model list updates

SBQ reads models from supported **installed agent CLIs**, not from arbitrary guessed model names. The **Refresh this agent's models** button forces discovery. When SBQ is visible, relevant model catalogs refresh around every **two minutes**, and the app rechecks on focus. If a CLI cannot report its catalog, SBQ explicitly shows a static documented suggestion or an unavailable state. An externally released model is visible **after the provider exposes it through the installed CLI**, and the current account/provider is configured; SBQ does not silently update the CLI binary or bypass entitlements.

For OpenCode/Kilo the refresh can fetch upstream model metadata. There is no guaranteed push event or instant notification from all external CLI providers. Use **CLI default** when unsure, or Custom ID only when you know the exact provider identifier.

## Packaging and releases

CI recipe: `.github/workflows/release.yml` runs Electron Builder on Windows, macOS and Ubuntu to produce OS-specific installer artifacts; separately packages the VS Code extension. Trigger manually from Actions or push `v*` tag.

Local packaging (requires npm dependencies and the target OS's build tools):

```bash
npm run dist:linux     # on Linux
npm run dist:win       # on Windows
npm run dist:mac       # on macOS
npm run extension:package
```

Files appear in `release/` and `apps/vscode/*.vsix`. The artifacts are *not* generated or verified in this source ZIP; platform build runners must compile them. For reproducible public releases, commit a generated `package-lock.json` from a network-enabled environment, use `npm ci` in CI, lock down dependency updates, and add platform signing/notarization.

## Linux Electron sandbox issue (source installs)

For your development/source checkout, `npm run desktop` may fail with `FATAL:setuid_sandbox_host.cc` when the Electron SUID helper has incorrect ownership or mode. Run:

```bash
npm run doctor:linux
```

If prompted, inspect the reported sandbox helper path, then apply the exact ownership and mode commands printed by the doctor. Do **not** run the Electron application with `sudo` or make `--no-sandbox` your default. This is a source-install helper issue; packaged installations have their own permissions/user-namespace requirements, which must be tested per distribution.

## Dev commands

```bash
npm run check              # JavaScript syntax validation
npm run test:smoke         # local engine and workflow tests
npm run test:integration   # existing login, model errors, git review
npm run test:sbq           # Claude IDs and Gemini adapter
npm run test:hub           # Kilo Auto Free, Freebuff safety and stage execution
npm run sync:extension     # share frontend assets with extension
```

Tests use **mock CLIs** and temporary repositories, never real model calls or your actual paid account. Native installer tests and real-account authentication testing require the corresponding operating systems and provider access.

## Limitations and security

- Automatic review/fix retries, quota-driven model handoffs, persisted runs, and cost-accurate metering are **not implemented** in this preview.
- Kilo may require confirmation of tool permissions in headless mode; SBQ does not automatically enable Kilo’s risky `--auto` (approve-all) flag. Use an agent that supports safe unattended permissions for fully hands-off tasks.
- Runs execute sequentially in a selected working directory. Stage roles marked review/plan use the CLI's read-only/plan controls where available. Verify agent permissions yourself before using a valuable project.
- Git diffs show changes in the current working tree, including changes that predate the run. Always inspect them. The app does not automatically commit/push.
- The engine listens only on `127.0.0.1` and uses a random bearer token in `~/.sbq-agents-hub/daemon.json` (or user profile equivalent). Keep that file private; never commit it.
- Each CLI may transmit prompts, source code or tool output to its provider's services. SBQ never imports login cookies/secret files into its own database.
- Unsigned preview installers are suitable for testing and open-source development, not unattended distribution to third parties.

## Project structure

```text
apps/desktop/           Electron app and preload bridge
apps/vscode/            VS Code extension and synced webview
packages/engine/        Agent command adapters, local server, Git inspection
packages/ui/            Shared SBQ chat-first UI
scripts/                Setup doctor and integration tests
.github/workflows/      OS packaging and VSIX release workflow
```

## License

SBQ Agents Hub source is available under `LICENSE` (MIT). Its third-party dependencies, agent CLIs and provider APIs retain their own licenses and terms. The SBQ logo was supplied by the project owner and its artwork/trademark rights are not automatically granted by the MIT code license.


## Responsive layout (v0.5.1)

The desktop app and VS Code extension use the same responsive UI. The layout adapts automatically when resizing:

- **Wide windows:** persistent stage inspector next to the live chat.
- **Medium windows (up to 1220px):** chat takes the full width; click **Stage settings** to open a drawer. Click a workflow stage chip to configure it, or press **Esc** to close.
- **Narrow windows / VS Code sidebars (up to 650px):** a bottom navigation bar provides Chat, Workflows, Connections and Code changes. Code diffs can scroll horizontally without widening the app.
- **Short windows:** the old forced 630px minimum height is removed, and the main content scrolls independently.

After updating, restart the desktop app or reinstall/reload the VS Code extension so it loads the updated CSS and JavaScript.
