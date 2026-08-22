# Praetorium

Praetorium is a local-only Owner Console for running several real Codex workstreams with minimal human intervention.

- One Owner Console
- Three project Directors
- One Skill Director
- Dynamically sized, isolated implementation and review workers
- Hermes profiles and Kanban state
- Codex app-server inference over child-process stdio

Praetorium never starts a remote-control service. Its small HTTP server is forced to `127.0.0.1`; non-loopback bind settings, peers, and Host headers are rejected. Hermes gateway, dashboard, webhook, messaging, Tailscale, daemon, browser terminal, PR, CI/CD, and legacy Cockpit workflow modes are not included in the product runtime.

## Install on the company Windows PC

The only expected interactive step is `codex login` when the machine has not already been authenticated.

```powershell
$installer = Join-Path $env:TEMP 'install-praetorium.ps1'
Invoke-WebRequest https://raw.githubusercontent.com/wooinwoo/claude-code-cockpit/v2.0.0/scripts/install-praetorium.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -ProjectsRoot C:\projects
```

The installer:

1. installs Git and Node.js through winget when missing;
2. installs Codex CLI `0.149.0` and verifies the local Codex login;
3. downloads and checksum-verifies Hermes `v2026.8.19` / Agent `v0.20.5`;
4. checks out the exact Praetorium `v2.0.0` release;
5. installs 14 role profiles, 12 skills, four boards, and the pinned Codex runtime bridges;
6. downloads the Windows release installer and verifies its SHA-256 file;
7. installs and launches Praetorium, then rejects the installation if port `3847` is not loopback-only.

The GitHub repository name and old `COCKPIT_*` identifiers remain accepted for upgrade compatibility. The product, data directory, and executable are named Praetorium.

## How it works

```text
Owner
└─ Praetorium Owner Console (127.0.0.1:3847)
   ├─ Project Director 1 → isolated implementer/review/fix workers
   ├─ Project Director 2 → independent worker pool and quality loop
   ├─ Project Director 3 → independent worker pool and quality loop
   └─ Skill Director     → evaluated skill lifecycle
```

Each Owner message starts a fresh Director Codex app-server session. Praetorium injects only a bounded handoff of the last eight completed turns, capped at 24,000 characters. This avoids unbounded Director context growth and Hermes `v0.20.5` resume stalls.

Hermes stores durable profiles, boards, tasks, results, and worker lifecycle state. The scheduler evaluates all three project boards independently every ten seconds, so a slow or broken project does not stall the others. Parallelism is selected from ready work, running work, CPU, and memory, capped at 12 workers.

## Owner Console

Open the desktop app or browse locally to `http://127.0.0.1:3847`.

The single product screen contains the three project Directors, Skill Director, current worker board, Owner decision queue, and Director conversation. There are no worker tabs to manage.

Project slots are populated from existing configuration. On a fresh install, Praetorium discovers up to three immediate Git repositories under `PRAETORIUM_PROJECTS_ROOT` (legacy `COCKPIT_PROJECTS_ROOT` is accepted; default `C:\projects`). The Project dialog can replace or rediscover assignments.

## Roles and skills

Profiles:

- `project-director-1`, `project-director-2`, `project-director-3`
- `skill-director`
- `codex-implementer`
- `security-reviewer`, `convention-reviewer`, `adversarial-reviewer`
- `test-gap-reviewer`, `architecture-reviewer`, `performance-reviewer`
- `release-reviewer`, `remediator`, `quality-gate-reviewer`

Skills:

- `project-director`, `skill-director`, `context-handoff`
- `security-review`, `convention-review`, `adversarial-review`
- `test-gap-review`, `architecture-review`, `performance-review`
- `release-readiness`, `remediate-findings`, `quality-gate`

Specialist reviews are fresh-context, read-only, and bound to an exact revision or artifact digest. Implementers do not review their own work, fixers are separate from reviewers, and relevant reviews become stale after remediation changes the candidate revision.

## Approval and sandbox policy

Praetorium is designed for background operation without approval popups inside the authority already granted by the Owner:

- every Codex app-server remains in `workspace-write`, never full-access;
- the selected project is the app-server thread root;
- only the active Hermes board directory is added as an extra writable root;
- sandboxed shell network access is disabled for Director and worker runs;
- inherited gateway, relay, webhook, and messaging environment variables are stripped;
- external actions, new authority, irreversible operations, and material product decisions remain Owner decisions;
- unattended escalation without a local decision path fails closed.

The pinned bridge applies only to Hermes Agent `v0.20.5` and fails closed on an unknown layout. It removes a redundant Hermes OAuth preflight while leaving the real Codex app-server login check intact, fixes the narrow Windows Kanban writable-root override, and makes the selected project override static profile working directories.

## Local development

Requirements: Node.js 22+, Rust stable, Codex CLI `0.149.0`, and the pinned Hermes installation.

```powershell
git clone https://github.com/wooinwoo/claude-code-cockpit.git
cd claude-code-cockpit
npm ci
npm test
npm start
```

Bootstrap profiles and skills:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap-director-system.ps1 -DefaultWorkdir C:\projects
```

Build the Windows desktop installer:

```powershell
npm run tauri build -- --bundles nsis
```

## Security invariants

- HTTP listens on `127.0.0.1` only; the product has no WebSocket or browser shell endpoint.
- Non-loopback socket peers are rejected before routing.
- Host headers are limited to `localhost`, `127.0.0.1`, and IPv6 loopback forms.
- No LAN discovery, remote-connect route, login token, proxy, or remote bridge is registered.
- State-changing requests require a same-host Origin when an Origin or Referer is present.
- Hermes child processes use argument arrays with `shell: false`.
- Director state and project assignment are written atomically; interrupted runs recover as failed on restart.
- Existing user project changes are never reset or discarded by the installer.

## Release

Tags matching `v*` run the active test suite and build Windows NSIS and macOS DMG artifacts. Release assets include SHA-256 checksum files. The company-PC bootstrap currently supports Windows; macOS packaging remains available for the desktop shell.

License and internal deployment policy follow the repository and company policy.
