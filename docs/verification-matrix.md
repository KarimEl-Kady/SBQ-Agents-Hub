# SBQ Agents Hub v0.5.14 — Release acceptance matrix

**Status: offline-tested release candidate, NOT production certified.**

## Automated, repeatable checks

Run `npm run check && npm run test:all` on a clean checkout. The 16 suites execute without paid AI calls and cover:

- Syntax and local bearer-authenticated API; model selection and validation.
- Real local file snapshots in repositories with **and without Git**; bounded diffs and sensitive file preview exclusion.
- Planning -> implementation -> independent review FIX -> implementation retry -> PASS, with full plan context preserved.
- Structured permission denial and bounded resume; no implicit tool escalations.
- Codex stdin EOF, denied sandbox preflight, unsuccessful CLI turns, and no-op protection.
- Antigravity local confirmation vs optional paid probe.
- Docker blocked/partial file recovery with explicit user consent; no duplicate planning.
- **New:** Existing missing dependencies prevent any model call; monorepo hoisting and empty project detection; incomplete implementer output cannot be marked successful by exit code alone.
- Responsive structure / mobile VS Code layout basic assertions (not visual approval).

## Mandatory hands-on tests on your Linux workstation

These are not simulated by the offline suite. Before publishing a "stable" SBQ release, complete **every** relevant row with evidence and your approval.

| Case | Manual check | Expected | Status |
|---|---|---|---|
| Electron launch | `npm run doctor:linux`, then `npm run desktop` | App opens without disabling Chromium sandbox | Not run on your machine |
| CLI logins | Connections: Claude, Codex, Antigravity, OpenCode | Honest status; no token file import; Antigravity user-confirmation ≠ verified | Not run |
| Codex sandbox | `codex sandbox -- /bin/true` or syntax from local `codex sandbox --help` | Exit 0 without `bwrap/RTM_NEWADDR` | Previously blocked on your machine |
| npm registry | `npm run doctor:project -- /home/karim/projects/crm --network` | Required deps ready; host registry reachable when provisioning | Not run |
| Docker (if required) | `docker info`, `docker compose ps` | Daemon reachable; service healthy | Not run |
| Planning | Use a disposable fixture project with approved decisions | Full plan saved, no code mutations, no false denial | Not run |
| Implementation | Write a small deterministic test file | Actual file diff and explicit COMPLETE or honest PARTIAL/BLOCKED | Not run |
| Review/Fix | Introduce known missing test -> FIX -> correction -> PASS | No repeat of paid planning; reviewer sees exact diff | Not run |
| Test/build | Configure `verifyCommand` for a known test script | Verified command exit 0; failed check blocks release | Not run |
| Recovery | Simulate stopped Docker mid-stage, then restore | Partial diff retained; resumed stage only on user confirmation | Not run |
| Release | Prepare commit, ask for privileged operation | No automatic git push or deployment | Not run |
| Restarts | Close and reopen app after run | Saved history visible; interrupted runs not billed again automatically | Not run |
| VS Code | Load extension and run in narrow side pane | Connection and same workflow status; no clipped controls | Not run |
| Windows/macOS | Install and run native Electron bundles | Launch and local connections | Not run |

## Important boundaries

- The application does **not** currently have general network access to your sandboxed AI agents; do not add blanket privileges or `--dangerously...` flags as a workaround. For a blocked npm install, get dependency prerequisites ready **on the host** after reviewing the package's scripts.
- `SBQ_STAGE_STATUS: COMPLETE` is an agent claim; SBQ requires observable files and, when configured, a successful independent verification command. It is not a mathematical proof of correctness.
- The project-doctor only checks known Node.js manifests. It is not a complete lockfile integrity audit or a Java/Go/Rust dependency checker.
- For brand-new scaffolds with no package manifest at the start, the dependency gate cannot predict which npm packages will later be needed. Future work: permissioned host dependency setup with a user-reviewed manifest, exact command and no implicit install.
- The code-review loop cannot verify untestable acceptance criteria on its own; require explicit decisions and manual approval for releases.
- No on-device real API subscriptions, token usage, or paid-agent end-to-end run was available for this package build.
