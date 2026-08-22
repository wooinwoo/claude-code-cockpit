# Praetorium repository instructions

Praetorium is a local-only Tauri 2 desktop shell around a narrow Node.js HTTP server and a Hermes/Codex orchestration layer.

## Non-negotiable invariants

- Bind HTTP only to `127.0.0.1`.
- Reject non-loopback peers and unrecognized Host headers before routing.
- Do not add remote-control, LAN, Tailscale, proxy, tunnel, messaging, webhook, gateway, or daemon modes.
- Hermes and Codex integration must use child-process stdio. Never start `hermes gateway`, `dashboard`, `serve`, or `kanban daemon`.
- Do not weaken Codex to a full-access sandbox. Restrict writes to the active project plus the exact active board directory.
- Unattended operations fail closed when they require authority outside the current project objective.
- Preserve existing user changes and data. Never reset, discard, or clean a project automatically.

## Architecture

- `server.js`: process lifecycle and the loopback HTTP boundary
- `routes/directors.js`: Owner Console Director API
- `lib/director-service.js`: persistent Director registry, bounded handoff, scheduler
- `lib/hermes-runtime.js`: stdio-only Hermes process adapter and sandbox environment
- `lib/local-only.js`: loopback and Host invariants
- `lib/praetorium-config.js`: three project slots and upgrade migration
- `js/owner-console.js`, `css/owner-console.css`: Owner Console UI
- `.agents/skills/`: reusable Director/reviewer/remediation/gate skills
- `.agents/hermes-profiles/souls/`: role prompts
- `scripts/bootstrap-director-system.ps1`: deterministic local profile/board setup
- `scripts/patch-hermes-codex-runtime.ps1`: pinned Hermes `v0.20.5` compatibility bridge
- `scripts/install-praetorium.ps1`: company-PC installer
- `src-tauri/`: desktop shell and NSIS/DMG packaging

Three project Directors and one Skill Director are the stable semantic layer. Workers are disposable fresh sessions. Reviewers are fresh-context and read-only; implementers, reviewers, and remediators remain separate. Reports are revision-bound and must be rerun when relevant source changes.

## Verification

Run before release:

```powershell
npm test
npm run tauri build -- --bundles nsis
```

Also validate every `.agents/skills/*/SKILL.md`, parse all PowerShell scripts, verify a hostile Host receives 403, confirm port 3847 has no non-loopback listener, and exercise one real Director-to-multiple-worker workflow without modifying a read-only review target.
