# SBQ architecture notes

The main security boundary is the **local orchestration engine**. Electron and VS Code send method/path/body messages through trusted bridges. The renderer/webview never sees the engine bearer token; only Electron's main process or VS Code's extension host uses it.

```
SBQ Electron renderer -- contextBridge/IPC -- Electron main --+ 
                                                       | local loopback HTTP + bearer token
VS Code Webview -- postMessage -- VS Code extension ---+-- Node engine -- spawn official CLI
```

Authentication is delegated to official CLI login flows. A Connect button opens a trusted local terminal with a known fixed command; the app never hosts a custom provider OAuth callback or sees refresh tokens.

The workflow model currently uses a sequential list. For production, represent each stage with immutable IDs and explicit `on_success`, `on_failure`, `max_attempts`, `review_contract`, `budget`, `quota_policy`, and `approval` fields. Validate DAGs with bounded cycles; persist each transition as an event. Use separate Git worktrees per writing agent and verify the content at every handoff.

Quota Guard is a **checkpoint format/reference**, not an automatic quota source. Quota monitoring should only use published and reliable provider telemetry (or handle actual quota errors) and never fabricate remaining percentages. A fallback should check credentials/model availability, flush a checkpoint, quiesce the previous worker, verify Git state, resume at the earliest incomplete action, and re-run verification.

For release commands, enforce a host-level allowlist and user approval before push/deploy. Do not depend on prompts alone.
