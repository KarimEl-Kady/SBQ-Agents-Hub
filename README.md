# SBQ Agents Hub v0.5.14 — Reliability Audit (based on v0.5.13)

> **Based on the original v0.5.1 chat-first desktop UI.** This is a source-code reliability release, not a finished paid product, not a native Avalonia app, and not a guarantee of compatibility with every live provider account.

## What this release actually changes

- **Fail before spending architect tokens:** before starting the first stage, SBQ checks whether every configured runner exists, checks official free login-status signals where available, and verifies Codex's local Linux sandbox. A downstream Codex sandbox failure blocks the *whole* run before Claude/Opus planning starts.
- **Codex sandbox command updated:** the local self-test uses `codex sandbox -- /bin/true`, not the outdated `codex sandbox linux /bin/true`. Unsupported sandbox probes return *unverified* and block a paid Codex run until resolved; no unrestricted permissions are automatically enabled.
- **Architect plan survives handoffs:** a planning stage's actual text is captured as a local artifact and a bounded beginning+ending excerpt is sent to later stages and FIX retries. The latest review's specific corrective feedback also follows the implementer. Models remain selectable **per stage**.
- **Review / FIX contracts:** the reviewer must provide an explicit final PASS/FIX line and evidence-based corrections. Implementer success still requires real file observations; explicit PARTIAL or BLOCKED halts all roles even if CLI exits `0`. Optional supporting tasks can explicitly SKIP when there is genuinely no work.
- **Antigravity:** the `agy` parser now honors structured `SUCCESS`, `ERROR`, and `WAITING` results instead of treating exit `0` as sufficient. Existing IDE/CLI login is shared through the provider's keyring; because no dependable free login status is exposed, SBQ keeps `unverified` or `user-confirmed` until an *opt-in* live verification or successful execution. No credentials are copied.
- **Durable local evidence:** stage response artifacts and run history are stored with restricted local permissions in `~/.sbq-agents-hub/`. The Chat includes a **View full stage output** action, and a failed preflight displays a persistent message with the affected stage.
- **Safe restart behavior:** completed runs are visible after relaunch. A run that was actively executing at shutdown becomes **Interrupted**, with its recorded output preserved. It is **not** resumed automatically, so it cannot silently repeat expensive agent calls.
- **The existing UI is preserved:** Chat, Workflow Builder, Connections, Code Changes, VS Code sidebar, SBQ logo, and responsive layout remain from v0.5.1 lineage.

## Our intended development cycle

1. **Architect / Planning** — choose any strong model through Claude Code, Codex, or another supported runner. Analyze project code, design acceptance criteria, request missing business decisions.
2. **Implementation** — select an independent, cost-efficient runner and model; receive the architect plan and original user request; write real files and tests.
3. **Independent Code Review** — the architect/reviewer checks the plan, local changes and actual verification results. `FIX` returns a precise correction prompt to implementation, with a strict retry limit; `PASS` continues.
4. **Supporting Tasks** — a separately selected model does required fixtures/docs/seeders or explicitly skips unnecessary work.
5. **Final Review** — the selected reviewer verifies all original criteria.
6. **Release Preparation** — the lightweight agent prepares a checklist; **no automatic commit, push, deployment, or destructive operation** occurs without a separate explicit approval implementation.

The default workflow is only a template; every stage's agent, model, reasoning effort, instructions and ordering are configurable. `Plan → Implement → Review → Fix → Review` has offline regression coverage, but it has **not** yet been validated against the user's real authenticated provider CLIs and large repositories.

## Linux testing, safe first run

Unzip the complete source to a *new* directory, then inside `sbq-agents-hub`:

```bash
npm install
npm run check
npm run test:orchestration
npm run test:sandbox
npm run doctor:linux
npm run desktop
```

If Electron reports the Linux SUID sandbox-helper error, inspect the helper file and follow only the ownership/mode repair commands printed by `doctor:linux`; do not run the app as root. Electron's VSync warnings alone do not indicate a failed workflow.

**Before running your real Coupon task:** open Connections and verify local sign-ins; set individual Stage models to `CLI default` initially, especially Codex; run **Test Codex (no tokens)**. With the Linux `bwrap`/AppArmor issue unresolved, SBQ blocks the entire workflow **before** the expensive Planning call. Fix the host sandbox or choose a working implementation agent; don't use dangerous broad bypass flags.

## Automated tests

Run `npm run test:orchestration` for a full offline, mocked multi-agent conversation covering a long architect plan, Codex fix iteration, Claude PASS, optional Antigravity skip, OpenCode release checklist, and local artifacts. Additional scripts cover permissions, planning decisions, Codex sandbox, model recovery, authentication signals, and responsive layout. These tests do **not** replace real provider and native desktop tests.

## Still unfinished / risks

- Antigravity does not supply a trustworthy, free session-status API to this integration; user confirmation is not verified login.
- The Linux Codex Bubblewrap/AppArmor configuration must be fixed on the **host**. SBQ cannot safely repair it by granting unrestricted access.
- Approval continuation is still held in memory; an interrupted active run cannot automatically pick up from a live model session after restart. Local **history** is persistent, not cross-restart **execution continuation**.
- Quota-aware automatic model handoff, official live permission bridge for every runner, comprehensive automated acceptance-testing, independent non-Git hunk-level review, secure automated Git publishing, billing, and Native C# + Avalonia are **not** delivered in this release.
- Provider costs remain your responsibility; quoted CLI usage is not necessarily the amount billed to an external subscription.
- Source packages have not been end-to-end GUI-tested on the user's Linux desktop or all Windows/macOS environments. Verify CLI compatibility and security policy before using on production code.

---

## Prior release documentation (historical)

**The Wise AI Workspace** — a local-first desktop app and VS Code extension for orchestrating your coding CLIs in a chat-first development workflow.

Prior release: **0.5.10 (Codex Linux sandbox preflight; based on the v0.5.1 UI and previous fixes)**. The code and tests are included. The desktop app is based on Electron; the engine is Node.js; both interfaces share the same local engine. This release is not yet a production-hardened autonomous agent system.

## v0.5.10 — Codex sandbox preflight and BLOCKED-stage diagnostics (November 2026)

- Codex Linux Bubblewrap preflight: `codex sandbox linux /bin/true` before sending any model prompt. If the Linux sandbox fails to initialize, the stage stops with actionable `CODEX_SANDBOX_BLOCKED` diagnostics and no model request. Unsupported older CLIs remain unverified rather than incorrectly blocked.
- Codex Connections → Test Codex now includes the local sandbox status (`ready`, `blocked`, or `unverified`) without spending model tokens.
- Explicit `SBQ_STAGE_STATUS: BLOCKED` / `PARTIAL` now wins over generic zero-file-change messages; actual repository edits are still required for verified completion.
- Handles structured failed Codex command events containing Bubblewrap failures, even if the CLI returns exit code 0.
- Recommended Ubuntu repair: install distro `bubblewrap` first; on Ubuntu 24.04 consult https://learn.chatgpt.com/docs/sandboxing for the supported AppArmor profile. Do not disable sandboxing or host-level security automatically.
- New offline regression test: `npm run test:sandbox`.

## v0.5.8 — Explicit tool approval & partial-progress recovery (November 2026)

This release retains the responsive **0.5.1 chat-first Electron UI** and adds a safer permission workflow to address a real user case: Claude spent tokens, changed some coupon code, then received structured denials for `Bash`, `Write`, and `Read`. In 0.5.7 that was reported as a generic failure even though useful files might already have been written.

- **Needs approval, not generic Failed:** structured Claude `permission_denials` become a paused run with an in-chat approval panel. `exit 0` is not treated as verified completion when any tools were denied.
- **See the actual requested operation:** show tool name, exact command/path when Claude reports them, and the number of source files already changed. SBQ avoids parsing unrelated prose as a denial.
- **Narrow per-attempt permissions:** only explicitly selected, recognized commands or in-workspace file paths are permitted. No unrestricted `Bash` or `--dangerously-skip-permissions` option is offered. A read request for `~/.claude/plans/...`, other files outside the project, or sensitive `.env` files does not get an automatic approval rule; provide the necessary content in the task or use the provider's own trusted interactive permissions instead. Managed deny/ask policies still take precedence.
- **Preapprove expected checks before the token-heavy stage:** In Workflows → edit Claude Implementation/Support → select exact commands such as `php artisan test`, `vendor/bin/pint`, `npm test`, etc. This is **opt-in**; the selected commands are permitted to run without prompting during that stage. The role still controls whether the stage may edit source.
- **Continue the same Claude session when available:** after choosing scoped approvals (or writing instructions to avoid a denied tool), SBQ invokes the same stage with `claude --resume <session_id>` when Claude returned a session ID. Earlier completed stages are not repeated. An additional model call can still consume tokens. If a session is unavailable, continuing may regenerate stage work; no zero-token guarantee.
- **Preserve partial code:** before stopping on permission denial, the engine snapshots changed project files and reports them as partial progress. Partial changes are carried forward when the stage resumes; code isn't assumed correct just because some files were modified.
- **Completion gate:** for new runs, the CLI is instructed to emit `SBQ_STAGE_STATUS: COMPLETE|PARTIAL|BLOCKED`. Explicit `PARTIAL`/`BLOCKED` blocks automatic progression even when files changed. File changes, optional real test commands, and review verdicts are still required as configured; a text-only completion declaration is not sufficient.
- **Usage transparency:** when Claude reports a numeric USD cost in the result event, SBQ displays it as *CLI-reported cost* rather than claiming it represents an extra billed charge under a subscription.
- **Limited retries:** permission continuation is limited to 3 attempts. A paused run locks its local project against concurrent runs; use **Stop** to abandon the paused run without deleting the changes. For a command rejected by managed provider policy, stop and adjust the official CLI settings rather than retrying blindly.

**Limitations:** Pending runs and approvals are held in the local Engine process memory, not durably recovered after app/engine restart. Keep SBQ open while approving; do not promise token-free retries. The new approval callback applies to Claude's CLI and uses its documented `--allowedTools` and `--resume` flags; other runners still need their own provider-specific approval adapters. This is not the full interactive Claude Agent SDK permission callback system. There is no automatic approval for destructive operations or external file reads.

Test with `node scripts/test-permission-workflow.mjs` (mocked Claude, no tokens). This test covers a real partial write, denied test command + external plan read, authorization of one exact command, resumable Claude session, reviewer PASS, and verification that planning was not repeated. Run `npm run check` and the other existing tests before upgrading.

## v0.5.7 — Antigravity sign-in status without importing credentials

The official Antigravity IDE/App and `agy` CLI share the operating system's keyring. Antigravity does not document a free `agy auth status` command, so previous SBQ releases always displayed **Session unverified**, even after successful login.

Connections now provides two intentionally different actions for Antigravity:

- **I have signed in (no tokens)**: records *your own confirmation* locally, displays **Signed in (you confirmed)**, and does not execute a model request or access any stored credentials. This is not independent authentication verification.
- **Verify with small model request**: after you explicitly acknowledge possible token/quota consumption, runs one read-only `agy -p` request in a local SBQ data folder and requires a successful JSON status and matching response before displaying **Connected**. It stores only the timestamps; never a token or key. A failed recheck removes the previous independent verification, while leaving your provider account untouched.

A successful Antigravity workflow stage also records a successful execution proof; session proof is time-limited and does not guarantee quota or access to every model. Both Desktop and VS Code Connections use the shared engine. No model requests occur during ordinary Connections refreshes.

Run `npm run test:antigravity` to test confirmation, explicit consent, success, failure, and zero-token status checking with a mock CLI.

**Important:** This test does not run against your actual account; a real sign-in and optional live check must still be tested on your machine. This does not add OAuth credential access to SBQ.

## v0.5.6 — Claude planning results, permission checks, and decisions

- Fixes a false-negative check where any prose containing “permission denied” or “approval unavailable” incorrectly failed a **successful Claude planning run with exit 0**. The engine now evaluates structured CLI errors and actual `permission_denials` rather than keyword-scanning its whole output.
- An explicit structured permission denial or CLI error still blocks the workflow and shows the reason.
- Plans that end with **Questions for you:** enter **Needs input** rather than being marked failed or silently proceeding on business assumptions. Answer the questions in the chat composer and select **Continue with my answers**. The workflow continues at the next stage without rerunning the expensive planning stage.
- The continuation is **in-memory for this release**. Keep the app/engine open while answering; restart loses the pending continuation. This is not full persisted resume.
- Do not re-run planning or change an access model automatically when a stage fails. For real provider quota, model access or authentication errors, read the structured CLI output.
- Regression test: `npm run test:claude-plan` (mock CLI, no provider tokens).

## v0.5.5 — Codex reliability and transparent errors (November 2026)

This patch fixes a real integration defect: the Electron/Node bridge used to leave the child process stdin open while passing a long prompt as a positional argument. Some versions of Codex then waited at **“Reading additional input from stdin...”** and eventually failed or timed out. **Now SBQ invokes `codex exec ... -` and writes the prompt to stdin, then explicitly closes stdin.** All other CLI processes also receive EOF to prevent silent waiting.

Additional fixes:

- Structured Codex `turn.failed` / `error` events and stderr are visible in the live chat, with an explicit failure reason and no silent JSON suppression.
- Timeout is reported as **TIMEOUT** instead of a generic `exit 1`; write stages can never be approved based solely on process exit.
- Fixed a review-parser regression where concatenated CLI messages could turn `SBQ_REVIEW_VERDICT: PASS` into `PASSCodex...` and incorrectly stop a legitimate review.
- Connections now includes **Test Codex (no tokens)**, checking CLI installation, version, and official login status without starting a paid model request.
- Fixed a desktop daemon-version mismatch that could prevent reuse of the current engine instance.
- Added `npm run test:codex`, a completely offline regression suite that simulates the CLI reading from stdin, modifying real files, reviewing, failing, and making no changes.

### Upgrade from v0.5.4 on Ubuntu/Linux

1. Close SBQ and stop old `npm run engine` terminals before upgrading. Your workflow settings are stored at `~/.sbq-agents-hub/workflow.json` and do **not** need to be deleted.
2. Extract the complete v0.5.5 ZIP to a **new directory**. Avoid overwriting a running app or mixing installed dependencies from another release.
3. Run `npm install`, `npm run doctor:linux` (follow its output if necessary), then `npm run desktop`. For development environments, Node.js 22 LTS is recommended.
4. Open **Connections**, choose **Test Codex (no tokens)**. Confirm the CLI is installed and signed in. If needed, run `codex login` yourself.
5. Under **Stage settings**, start with **Codex → CLI default → Default reasoning**. Once the first successful local edit is verified, choose a specific accessible model and reasoning level.
6. For a low-risk first test, select a disposable Git project and ask Codex to add a tiny test file. Confirm the file appears in the project and **Code changes**. Only then try a long-running multi-agent workflow.

**Important:** A successful CLI login check does not prove access to a specific model. SBQ will show the provider's actual error if access is denied. Real Claude/Codex accounts have not been tested in this build environment. There is no automatic quota switching or persisted run recovery yet. A run failing halfway through does not authorize SBQ to replay high-cost stages without your approval.

## What changed in v0.5.4 — don't pay for a false "done"

The original 0.5.1 engine considered a CLI exit code of 0 to mean a successful stage even when **zero repository files changed**. Claude was also launched in plan/read-only mode for support stages, so some implementations were impossible. v0.5.4 fixes this in the original Electron/VS Code codebase, preserving the 0.5.1 responsive UI.

- **Role-specific permissions:** plan, review, and release preparation are read-only; implementation and support request workspace editing (not approve-all). Actual CLI permission policies and account access still apply.
- **Local file evidence:** SHA-256 snapshots before/after every stage; Git tracked and untracked files when available, or local source files without a Git repository. Each stage reports concrete added/modified/deleted paths in chat.
- **Fail-closed writing:** if a write stage returns exit 0 but changes zero relevant files, SBQ marks `needs-attention` and **does not call the next expensive agent**. Read-only stages are also blocked if they unexpectedly modify files.
- **Review/fix loop (opt-in):** a review must return exactly `SBQ_REVIEW_VERDICT: PASS` or `FIX`. On FIX, return to the configured prior implementation/support stage (0–5 retry limit). Unclear verdict stops for manual review. Actual source changes must have occurred earlier.
- **Verification commands:** optionally run a project check after a stage: `npm test`, `npm run test`, `npm run build`, `npm run lint`, `pnpm test`, `pnpm build`, `dotnet test`, `php artisan test`, `composer test`, or `pytest`. No shell pipelines or arbitrary commands in this field.
- **Template:** Workflows → **Use verified 6-stage template** for Planning → Implementation → Review → Supporting Tasks → Final Review → Release Preparation. The template is only saved when you press Save workflow. Older saved workflows aren't automatically overwritten.
- **Useful debug events:** CLI errors, read-only violations, file-change evidence, test failures, review decisions, and terminal `needs-attention`/`needs-review` states in both Desktop and VS Code.

### To avoid spending tokens without code changes

1. Choose the **actual project folder** in Chat, not the SBQ app source unless you intend to modify SBQ.
2. In Workflows, set code-writing tasks to **Implementation** or **Support**, select the intended CLI agent/model and leave **Require actual project file changes** enabled.
3. Use an official CLI login. Some providers require explicit workspace write/tool permissions in their own configuration. SBQ does **not** enable unrestricted tools or bypass permissions automatically.
4. Start with a small concrete task, e.g. *"In this project create `src/sbq-test.txt` containing a single line and verify the file exists."* Test on a disposable repo.
5. Watch Chat for the **File verification** event and inspect Code Changes. A completion event without file evidence is not proof of working code.
6. Optional: choose a verification command that exists in your target project. For example, choose `npm test` only if the project has a working npm test script.

**Important limitations:** A file hash proves that bytes changed, **not** that the feature is correct, the tests are comprehensive, or the GitHub remote was updated. GitHub pushes require separate user approval. The stage evidence ignores ignored/build directories and large files; if its evidence scan is incomplete it refuses to approve. Real-provider end-to-end behavior still needs to be tested on the user's machine.

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
npm run test:hub           # Kilo Auto Free, Freebuff, no-op detection
npm run test:verification  # no-op agent blocked, real repo edits, FIX → retry → PASS
npm run test:responsive    # responsive UI + synced VS Code assets
npm run sync:extension     # share frontend assets with extension
```

Tests use **mock CLIs** and temporary repositories, never real model calls or your actual paid account. Native installer tests and real-account authentication testing require the corresponding operating systems and provider access.

## Limitations and security

- **Opt-in bounded review/fix retries are implemented** with explicit PASS/FIX. Quota-driven model handoffs, persisted runs, and cost-accurate metering are **not implemented** in this preview.
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
packages/engine/        Agent adapters, filesystem verification, server, Git inspection
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


## v0.5.10 — Model catalog mismatch recovery

- Saved models that disappear from a runner catalog now get an actionable stage-level notice in **Workflows**, rather than a disappearing toast or noisy IPC error.
- **Use CLI default (save)** avoids pinning a possibly inaccessible model and resets reasoning to default.
- **Refresh agent models** re-queries the local CLI. Model discovery does not make an AI coding request.
- **Keep ID as custom (save)** explicitly opts into an unlisted model ID; it may still be rejected by the actual provider or account. SBQ does not switch models behind your back.
- Codex model discovery falls back to the CLI's read-only `codex debug models` if app-server discovery is unavailable.
- Duplicate clicks on Run no longer create parallel requests while the first is pending.
- A catalog mismatch is a validation failure **before** any model tokens are spent. This does **not** repair separate Linux Bubblewrap sandbox failures.


## v0.5.12 — Actionable workflow recovery and chat-first interface

This release continues the **v0.5.1 Electron desktop + VS Code experience**. It is not yet an Avalonia installer and does not silently change provider credentials or host security settings.

**New UI:** a project header, real local CLI preflight status, clear stage pipeline, expanded stage-by-stage activity, a blocking environment recovery panel, a real verification-state label, and stage inspector fields for verification commands, actual-file-change requirements, and optional Docker readiness checks. The dashboard never invents a progress percentage, test result or login status. The same UI assets are synchronized into the VS Code extension.

**New engine behavior:** when an implementation stage writes files and then reports `SBQ_STAGE_STATUS: BLOCKED` or `PARTIAL`, SBQ stores those file observations as *partial* work and stops the remaining paid stages. For supported environment blockers (including missing Docker daemon access), SBQ can keep the completed Planning stage and retry **only that stage**. The retry requires explicit consent because it calls the model again. It checks local agent readiness, and for a previously observed Docker blocker it checks `docker info` again before retrying. It does **not** auto-retry when the service is still inaccessible. Stage-only retry state exists only in the currently running engine process; after restart the saved run becomes **Interrupted** instead of offering a broken resume button. No hidden token-free continuation is promised.

**Docker prerequisite:** opt into *Require Docker daemon before any model calls* on a stage if Docker is a hard prerequisite for your task. That protects an expensive planning request from being performed before finding out the Docker daemon is unavailable. SBQ will never run `sudo`, change system groups, or disable the Codex Sandbox automatically. If the agent uses Docker only incidentally, leave this option disabled.

**Reality checks:** local file-change observations are not proof that tests passed. When no verification command ran, the UI shows **Tests not run**, even if the workflow completed. A Git diff is available for local Git repositories without GitHub access. For directories not initialized with Git, SBQ still records changed files by snapshot but cannot show a full historical line diff.

### Linux update from v0.5.11

Close the old desktop app and any old `npm run engine` process first. Prefer the patch to preserve installed dependencies and existing Electron sandbox permissions:

```bash
cd ~/Downloads/sbq-agents-hub
git apply --check ~/Downloads/SBQ-v0.5.12-from-v0.5.11.patch
git apply ~/Downloads/SBQ-v0.5.12-from-v0.5.11.patch
npm run check
npm run test:orchestration
npm run test:recovery
npm run desktop
```

Stop if `git apply --check` fails. Apply to the matching v0.5.11 source, not another version. Existing user settings in `~/.sbq-agents-hub` are not included in the ZIP and are not overwritten. The patch contains the same UI code for Electron and the VS Code extension.

For a clean source install, extract the complete ZIP, run `npm install`, then `npm run desktop`. On Linux, rerunning Electron installation in a new directory may require repeating the documented sandbox-helper configuration for that **trusted installed binary**. Do not run the whole application with sudo.

### Validation limits

Automated tests use offline fake provider CLIs and disposable test repositories. A Chromium screenshot was inspected with a simulated blocked CRM run for desktop layout verification. A real Claude/Codex/Antigravity/OpenCode session, Docker daemon, and Electron compositor on your specific Linux machine were **not** exercised here. The Chromium VSync messages are generally a separate compositor diagnostic, not proof of workflow failure. If the app freezes or does not render correctly, investigate GPU/X11/Wayland separately rather than disabling security features by default.

## v0.5.13 — Git-less Code Changes & partial-stage evidence

This patch addresses a real bug from v0.5.12: the local verifier could report
files changed but the **Code changes** view and on-demand review refused to
work unless the selected folder was a Git repository.

- Each NEW stage captures a bounded local **before/after text baseline** and
  stores an audit preview of actual changed files on the run. A Git repository
  is not needed; `.git`, `node_modules`, `.env*`, and likely private or credential
  files are not included in text previews. Large/binary files show status only.
- A run's Code Changes panel shows that run's changes, not unrelated dirty Git
  files. A file list/diff is persisted under `~/.sbq-agents-hub/runs/` for the
  local run; previews are capped, may omit sensitive files and are never sent
  to SBQ Cloud. The configured **AI reviewer** can still transmit relevant
  local source excerpts to the provider selected by the user.
- Runs recorded by earlier versions only have file path/status evidence. They
  can show those paths, **not an invented historical line diff**.
- Clear project-folder label in chat; check it before starting a task.
- `Codex CLI turn ended` is treated as tool output, **not a passed stage**.
- Offline/incomplete dependency installation is identified separately from
  Docker and sandbox failures. `PARTIAL` remains partial: it does not advance
  to review or release, even with a zero exit code or six created files.

### What this does NOT solve automatically

SBQ cannot repair a project's npm registry/network or Docker permissions, nor
can it claim a complete CRM when dependencies, tests or docs are still missing.
Fix those prerequisites in the *target CRM folder*, validate them locally,
then explicitly retry the interrupted implementation stage. An already-paused
v0.5.12 run cannot be resumed after restarting the Engine: its stored events,
files and plan remain available, but in-memory CLI continuation state is lost.
Create an implementation-only follow-up using the saved plan if necessary.

### Test commands

```bash
npm run check
npm run test:gitless
npm run test:recovery
npm run test:orchestration
npm run test:responsive
npm run desktop
```

### Important trust limits

- "6 files changed" means six file hashes differed in the **selected local
  project** during a stage. It does **not** mean tests passed, docs completed,
  or the task delivered. Review the exact path in the chat heading and the
  source on disk before approving.
- The local diff is built from bounded text snapshots (not Git); when the
  source was too large or excluded, only the file/status is available.
- Git-based commit/push is still optional and requires separate approval.
- All automated tests use local mock CLIs. Real accounts, package registries
  and the desktop UI on your Linux machine still need validation.


## v0.5.14 — Reliability audit, not a guaranteed production release

This version stays on the v0.5.1-based Electron desktop UX. The prior v0.5.13 source remains the baseline. It adds **read-only project dependency readiness** and a stricter implementer completion contract. It does not install packages automatically or bypass network/sandbox permissions.

### Preflight before spending model tokens

Set the **Project directory** to the actual repository or local folder and use **Retry preflight**. For an existing Node.js project, SBQ examines `package.json` files at the root and in common `apps/*` / `packages/*` locations, checks whether required local packages are installed (including packages hoisted to root `node_modules`), and stops before Planning if required packages are missing. The check deliberately does not execute package scripts, read credentials, or contact an AI provider. A new empty directory is allowed. Yarn Plug'n'Play is recognized.

To diagnose your CRM folder from Ubuntu, without invoking any model:

```bash
cd ~/Downloads/sbq-agents-hub
npm run doctor:project -- /home/karim/projects/crm
# Optional short HOST network check (does not install anything):
npm run doctor:project -- /home/karim/projects/crm --network
```

If it says dependencies are missing, **review the package's scripts and lockfile** and install from your normal host terminal in the project folder (typically `npm ci` if a matching lockfile exists, otherwise `npm install`, or your project's package manager). Do not run `sudo npm install`; do not give Codex full network/host permissions automatically. Docker must be checked separately with `docker info` if the selected stage requires it. SBQ cannot repair your local DNS, npm registry, Docker service or Codex Bubblewrap/AppArmor sandbox on its own.

When a stage already made partial edits and has paused, **keep the engine open** and use **Continue this stage after fix** after fixing the external issue. It retries only that stage with your explicit approval (additional model tokens possible). An interrupted run from a previous launch is stored as history but is not automatically resumed.

For implement/support stages, `exit 0` + changed files is **not sufficient**: SBQ now requires the stage's explicit `SBQ_STAGE_STATUS: COMPLETE` declaration, or `SKIPPED` for a genuinely optional support stage. A missing declaration results in partial/needs-attention with retained local file evidence and no automatic paid review. A declaration does **not** prove correctness: configure the stage's **Verification Command**, and inspect the real test/build output and diff.

### Test coverage and remaining limitations

`npm run test:all` runs the 16 local contract/simulation test suites, including the new dependency preflight and incomplete-stage regression tests. These use mock CLIs and disposable repositories; they are **not** live account tests against your Claude, Codex, Antigravity and OpenCode sign-ins. Real integration acceptance still requires an opt-in sample project, your exact installed CLI versions and supported permissions, and passing the expected build/tests.

The upgrade does not include server-side subscription billing, guaranteed provider quota readings, live multi-agent authentication validation, or packaged native Avalonia apps. A Linux Electron SUID sandbox issue may recur after reinstalling Electron; run `npm run doctor:linux` and review its guidance.
