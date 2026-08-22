[CmdletBinding()]
param(
    [string]$HermesExecutable,
    [string]$HermesRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'hermes'),
    [string]$DefaultWorkdir = 'C:\projects'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceSkills = Join-Path $repositoryRoot '.agents\skills'
$sourceReferences = Join-Path $repositoryRoot '.agents\skill-references'
$sourceSouls = Join-Path $repositoryRoot '.agents\hermes-profiles\souls'
$HermesRoot = [IO.Path]::GetFullPath($HermesRoot)
$DefaultWorkdir = [IO.Path]::GetFullPath($DefaultWorkdir)
$profilesRoot = Join-Path $HermesRoot 'profiles'

function Resolve-HermesExecutable {
    param([string]$RequestedPath)

    $candidates = [Collections.Generic.List[string]]::new()
    if ($RequestedPath) {
        $candidates.Add($RequestedPath)
    }
    if ($env:HERMES_EXE) {
        $candidates.Add($env:HERMES_EXE)
    }
    $candidates.Add((Join-Path $HermesRoot 'hermes-agent\venv\Scripts\hermes.exe'))
    $candidates.Add((Join-Path $HermesRoot 'hermes-agent\bin\hermes.exe'))

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $command = Get-Command hermes -CommandType Application -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    throw 'Hermes v0.20.5 executable not found. Install Hermes or pass -HermesExecutable.'
}

function Invoke-Hermes {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$Capture
    )

    if ($Capture) {
        $result = & $script:hermesExe @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Hermes command failed ($LASTEXITCODE): hermes $($Arguments -join ' ')`n$($result -join [Environment]::NewLine)"
        }
        return $result
    }

    & $script:hermesExe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Hermes command failed ($LASTEXITCODE): hermes $($Arguments -join ' ')"
    }
}

function Set-DotEnvFlags {
    param([Parameter(Mandatory)][string]$Path)

    $required = [ordered]@{
        API_SERVER_ENABLED = 'false'
        WEBHOOK_ENABLED = 'false'
        GATEWAY_ALLOW_ALL_USERS = 'false'
        WHATSAPP_ENABLED = 'false'
    }

    $parent = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $lines = if (Test-Path -LiteralPath $Path) {
        [Collections.Generic.List[string]]::new([string[]][IO.File]::ReadAllLines($Path))
    } else {
        [Collections.Generic.List[string]]::new()
    }

    # Remove active messaging, webhook, API-server, proxy, and gateway
    # configuration. Commented examples remain intact. The owner console uses
    # child-process stdio only, so none of these are required.
    $remotePattern = '^\s*(?!#)(?:API_SERVER_|WEBHOOK_|GATEWAY_|RELAY_|TELEGRAM_|DISCORD_|SLACK_|WHATSAPP_|MATRIX_|MATTERMOST_|SIGNAL_|IMESSAGE_|EMAIL_|QQ_|LINE_|DINGTALK_|WECOM_|MSTEAMS_|MS_TEAMS_)[A-Z0-9_]*\s*='
    $clean = [Collections.Generic.List[string]]::new()
    foreach ($line in $lines) {
        if ($line -notmatch $remotePattern) {
            $clean.Add($line)
        }
    }
    foreach ($entry in $required.GetEnumerator()) {
        $clean.Add("$($entry.Key)=$($entry.Value)")
    }

    [IO.File]::WriteAllLines($Path, $clean, [Text.UTF8Encoding]::new($false))
}

function Copy-DirectorSkills {
    param([Parameter(Mandatory)][string]$DestinationRoot)

    $skillDestination = Join-Path $DestinationRoot 'skills'
    $referenceDestination = Join-Path $DestinationRoot 'skill-references'
    [IO.Directory]::CreateDirectory($skillDestination) | Out-Null
    [IO.Directory]::CreateDirectory($referenceDestination) | Out-Null

    Get-ChildItem -LiteralPath $sourceSkills -Directory | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $skillDestination -Recurse -Force
    }
    Get-ChildItem -LiteralPath $sourceReferences -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $referenceDestination -Force
    }
}

function Install-SoulTemplate {
    param(
        [Parameter(Mandatory)][string]$ProfileName,
        [Parameter(Mandatory)][string]$TemplateName,
        [string]$BoardSlug,
        [string]$ReviewSkill
    )

    $templatePath = Join-Path $sourceSouls $TemplateName
    $profilePath = Join-Path $profilesRoot $ProfileName
    $content = [IO.File]::ReadAllText($templatePath)
    $content = $content.Replace('{{PROFILE_NAME}}', $ProfileName)
    $content = $content.Replace('{{BOARD_SLUG}}', $(if ($BoardSlug) { $BoardSlug } else { 'none' }))
    $content = $content.Replace('{{REVIEW_SKILL}}', $(if ($ReviewSkill) { $ReviewSkill } else { 'specialist-review' }))
    [IO.File]::WriteAllText((Join-Path $profilePath 'SOUL.md'), $content, [Text.UTF8Encoding]::new($false))
}

function Set-ProfileConfig {
    param(
        [Parameter(Mandatory)][string]$ProfileName,
        [Parameter(Mandatory)][ValidateSet('ultra', 'xhigh')][string]$Reasoning
    )

    $settings = [ordered]@{
        'model.default' = 'gpt-5.6-sol'
        'model.provider' = 'openai-codex'
        'model.openai_runtime' = 'codex_app_server'
        'agent.reasoning_effort' = $Reasoning
        'approvals.single_query_mode' = 'deny'
        'approvals.cron_mode' = 'deny'
        # Praetorium itself is the non-interactive policy boundary. Codex still
        # runs workspace-write with a project cwd plus one board-only writable
        # root; approval prompts cannot be surfaced from a background Director.
        'approvals.mode' = 'off'
        'approvals.timeout' = '300'
        'approvals.denial_breaker_threshold' = '3'
        'security.allow_private_urls' = 'false'
        'security.redact_secrets' = 'true'
        'terminal.backend' = 'local'
        'terminal.cwd' = $DefaultWorkdir
        'auxiliary.free_only' = 'true'
        'kanban.dispatch_in_gateway' = 'false'
        'kanban.review_dispatch' = 'true'
        'kanban.auto_decompose' = 'false'
        'kanban.max_in_progress' = '12'
        'kanban.max_in_progress_per_profile' = '1'
        'kanban.failure_limit' = '2'
        'kanban.dispatch_stale_timeout_seconds' = '14400'
        'kanban.reconcile_orphans' = 'true'
    }

    foreach ($setting in $settings.GetEnumerator()) {
        Invoke-Hermes -Arguments @('-p', $ProfileName, 'config', 'set', $setting.Key, $setting.Value)
    }
}

$projectDirectories = @(Get-ChildItem -LiteralPath $DefaultWorkdir -Directory | Where-Object {
    Test-Path -LiteralPath (Join-Path $_.FullName '.git')
} | Sort-Object Name | Select-Object -First 3)

$projectSlots = for ($index = 0; $index -lt 3; $index++) {
    $number = $index + 1
    $directory = if ($index -lt $projectDirectories.Count) { $projectDirectories[$index] } else { $null }
    $board = if ($directory) {
        $candidate = $directory.Name.ToLowerInvariant() -replace '[^a-z0-9_-]+', '-'
        $candidate = $candidate.Trim('-')
        if ($candidate.Length -gt 0) { $candidate.Substring(0, [Math]::Min(48, $candidate.Length)) } else { "project-$number" }
    } else {
        "project-$number"
    }
    [pscustomobject]@{
        Number = $number
        Board = $board
        Name = if ($directory) { $directory.Name } else { "Project $number" }
        Workdir = if ($directory) { $directory.FullName } else { $DefaultWorkdir }
    }
}

$profileSpecs = @(
    [pscustomobject]@{ Name = 'project-director-1'; Description = "Semantic orchestrator for $($projectSlots[0].Name). Decomposes objectives, assigns isolated workers, and judges current review evidence."; Reasoning = 'ultra'; Soul = 'project-director.SOUL.md'; Board = $projectSlots[0].Board; ReviewSkill = $null },
    [pscustomobject]@{ Name = 'project-director-2'; Description = "Semantic orchestrator for $($projectSlots[1].Name). Decomposes objectives, assigns isolated workers, and judges current review evidence."; Reasoning = 'ultra'; Soul = 'project-director.SOUL.md'; Board = $projectSlots[1].Board; ReviewSkill = $null },
    [pscustomobject]@{ Name = 'project-director-3'; Description = "Semantic orchestrator for $($projectSlots[2].Name). Decomposes objectives, assigns isolated workers, and judges current review evidence."; Reasoning = 'ultra'; Soul = 'project-director.SOUL.md'; Board = $projectSlots[2].Board; ReviewSkill = $null },
    [pscustomobject]@{ Name = 'skill-director'; Description = 'Governance director for reusable agent skills. Converts observed behavior into evaluated, scoped skill proposals and controlled rollouts.'; Reasoning = 'ultra'; Soul = 'skill-director.SOUL.md'; Board = 'skill-governance'; ReviewSkill = $null },
    [pscustomobject]@{ Name = 'codex-implementer'; Description = 'Implementation worker for bounded code changes in isolated workspaces with test evidence and precise handoff.'; Reasoning = 'xhigh'; Soul = 'implementer.SOUL.md'; Board = $null; ReviewSkill = $null },
    [pscustomobject]@{ Name = 'convention-reviewer'; Description = 'Read-only reviewer for repository instructions, established local patterns, and public-interface conventions.'; Reasoning = 'xhigh'; Soul = 'reviewer.SOUL.md'; Board = $null; ReviewSkill = 'convention-review' },
    [pscustomobject]@{ Name = 'security-reviewer'; Description = 'Read-only reviewer for exploitable security and privacy risks across changed trust boundaries.'; Reasoning = 'xhigh'; Soul = 'reviewer.SOUL.md'; Board = $null; ReviewSkill = 'security-review' },
    [pscustomobject]@{ Name = 'adversarial-reviewer'; Description = 'Read-only reviewer that attempts to falsify claimed behavior with concrete boundary and failure counterexamples.'; Reasoning = 'xhigh'; Soul = 'reviewer.SOUL.md'; Board = $null; ReviewSkill = 'adversarial-review' },
    [pscustomobject]@{ Name = 'test-gap-reviewer'; Description = 'Read-only reviewer for regression-evidence gaps across acceptance criteria and changed risk paths.'; Reasoning = 'xhigh'; Soul = 'reviewer.SOUL.md'; Board = $null; ReviewSkill = 'test-gap-review' },
    [pscustomobject]@{ Name = 'architecture-reviewer'; Description = 'Read-only reviewer for module boundaries, dependency direction, public contracts, migrations, and shared state.'; Reasoning = 'xhigh'; Soul = 'reviewer.SOUL.md'; Board = $null; ReviewSkill = 'architecture-review' },
    [pscustomobject]@{ Name = 'performance-reviewer'; Description = 'Read-only reviewer for material latency, throughput, memory, I/O, concurrency, caching, and resource-limit regressions.'; Reasoning = 'xhigh'; Soul = 'reviewer.SOUL.md'; Board = $null; ReviewSkill = 'performance-review' },
    [pscustomobject]@{ Name = 'release-reviewer'; Description = 'Read-only release-candidate assessor for current build, test, review, migration, rollback, and operational evidence.'; Reasoning = 'xhigh'; Soul = 'reviewer.SOUL.md'; Board = $null; ReviewSkill = 'release-readiness' },
    [pscustomobject]@{ Name = 'remediator'; Description = 'Separate fixer for current revision-bound review findings with scoped changes and fresh re-review handoff.'; Reasoning = 'xhigh'; Soul = 'remediator.SOUL.md'; Board = $null; ReviewSkill = $null },
    [pscustomobject]@{ Name = 'quality-gate-reviewer'; Description = 'Final read-only gate that deterministically advances or stops an exact candidate revision from current evidence.'; Reasoning = 'xhigh'; Soul = 'quality-gate.SOUL.md'; Board = $null; ReviewSkill = 'quality-gate' }
)

$boardSpecs = @(
    [pscustomobject]@{ Slug = $projectSlots[0].Board; Name = $projectSlots[0].Name; Description = 'Isolated workstream owned by project-director-1.'; Workdir = $projectSlots[0].Workdir },
    [pscustomobject]@{ Slug = $projectSlots[1].Board; Name = $projectSlots[1].Name; Description = 'Isolated workstream owned by project-director-2.'; Workdir = $projectSlots[1].Workdir },
    [pscustomobject]@{ Slug = $projectSlots[2].Board; Name = $projectSlots[2].Name; Description = 'Isolated workstream owned by project-director-3.'; Workdir = $projectSlots[2].Workdir },
    [pscustomobject]@{ Slug = 'skill-governance'; Name = 'Skill Governance'; Description = 'Skill proposals, forward evaluations, canaries, activation, and rollback evidence.'; Workdir = $DefaultWorkdir }
)

foreach ($requiredPath in @($sourceSkills, $sourceReferences, $sourceSouls, $DefaultWorkdir)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required path not found: $requiredPath"
    }
}

$script:hermesExe = Resolve-HermesExecutable -RequestedPath $HermesExecutable
$version = (Invoke-Hermes -Arguments @('--version') -Capture) -join [Environment]::NewLine
if ($version -notmatch 'Hermes Agent v0\.20\.5\b') {
    throw "Expected Hermes Agent v0.20.5, got: $version"
}

# Hermes v0.20.5 otherwise asks for a second OpenAI OAuth login before it can
# launch the already-authenticated Codex app-server runtime. Install the pinned,
# fail-closed compatibility bridge before creating or exercising profiles.
& (Join-Path $PSScriptRoot 'patch-hermes-codex-runtime.ps1') -HermesRoot $HermesRoot
if ($LASTEXITCODE -ne 0) {
    throw "Hermes Codex runtime bridge failed ($LASTEXITCODE)."
}

$reportedConfigPath = ((Invoke-Hermes -Arguments @('-p', 'default', 'config', 'path') -Capture) | Select-Object -Last 1).ToString().Trim()
$reportedHermesRoot = [IO.Path]::GetFullPath((Split-Path -Parent $reportedConfigPath))
if ($reportedHermesRoot -ne $HermesRoot) {
    throw "Hermes root mismatch: CLI uses '$reportedHermesRoot' but bootstrap targets '$HermesRoot'."
}
Write-Host "Using $($script:hermesExe)"
Write-Host 'Remote surfaces remain disabled; this script never starts Hermes gateway, dashboard, serve, webhook, or kanban daemon.'

Set-DotEnvFlags -Path (Join-Path $HermesRoot '.env')
Copy-DirectorSkills -DestinationRoot $HermesRoot

foreach ($profile in $profileSpecs) {
    $profilePath = Join-Path $profilesRoot $profile.Name
    if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) {
        Invoke-Hermes -Arguments @(
            '-p', 'default', 'profile', 'create', $profile.Name,
            '--clone', '--no-alias', '--description', $profile.Description
        )
    } else {
        Write-Host "Profile '$($profile.Name)' already exists; reconciling configuration and assets."
    }
    Invoke-Hermes -Arguments @('-p', 'default', 'profile', 'describe', $profile.Name, '--text', $profile.Description)

    Set-DotEnvFlags -Path (Join-Path $profilePath '.env')
    Copy-DirectorSkills -DestinationRoot $profilePath
    Install-SoulTemplate -ProfileName $profile.Name -TemplateName $profile.Soul -BoardSlug $profile.Board -ReviewSkill $profile.ReviewSkill
    Set-ProfileConfig -ProfileName $profile.Name -Reasoning $profile.Reasoning
}

foreach ($director in $profileSpecs | Where-Object { $_.Reasoning -eq 'ultra' }) {
    Invoke-Hermes -Arguments @('-p', $director.Name, 'config', 'set', 'kanban.orchestrator_profile', $director.Name)
    Invoke-Hermes -Arguments @('-p', $director.Name, 'config', 'set', 'kanban.default_assignee', 'codex-implementer')
}

# Run Hermes' own supported migration function directly. The slash-command
# route builds a model session first and therefore asks for a redundant Hermes
# OAuth login even though the selected runtime delegates inference to the
# already-authenticated Codex CLI. Direct migration performs the exact same
# idempotent managed-block update without starting a model session or listener.
$pythonCandidates = @(
    (Join-Path $HermesRoot 'hermes-agent\venv\Scripts\python.exe'),
    (Join-Path $HermesRoot 'hermes-agent\bin\python.exe')
)
$pythonExe = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $pythonExe) {
    throw 'Hermes Python runtime not found; cannot run the supported Codex migration.'
}
$migrationCode = 'from hermes_cli.config import load_config; from hermes_cli.codex_runtime_plugin_migration import migrate; report=migrate(load_config()); print(report.summary()); raise SystemExit(0 if report.written and not report.errors else 1)'
$hadHermesHome = Test-Path Env:HERMES_HOME
$savedHermesHome = if ($hadHermesHome) { $env:HERMES_HOME } else { $null }
try {
    Remove-Item Env:HERMES_HOME -ErrorAction SilentlyContinue
    Push-Location (Join-Path $HermesRoot 'hermes-agent')
    try {
        & $pythonExe -c $migrationCode
        if ($LASTEXITCODE -ne 0) {
            throw "Hermes Codex migration failed ($LASTEXITCODE)."
        }
    } finally {
        Pop-Location
    }
} finally {
    if ($hadHermesHome) { $env:HERMES_HOME = $savedHermesHome }
}

$existingBoardsResult = (Invoke-Hermes -Arguments @('-p', 'default', 'kanban', 'boards', 'list', '--json') -Capture) -join [Environment]::NewLine
$existingBoards = @($existingBoardsResult | ConvertFrom-Json)
foreach ($board in $boardSpecs) {
    if (-not ($existingBoards | Where-Object { $_.slug -eq $board.Slug })) {
        Invoke-Hermes -Arguments @(
            '-p', 'default', 'kanban', 'boards', 'create', $board.Slug,
            '--name', $board.Name,
            '--description', $board.Description,
            '--default-workdir', $board.Workdir
        )
    }
    Invoke-Hermes -Arguments @('-p', 'default', 'kanban', 'boards', 'set-default-workdir', $board.Slug, $board.Workdir)
    Invoke-Hermes -Arguments @('-p', 'default', 'kanban', '--board', $board.Slug, 'init')
}

Write-Host "Director system reconciled: $($profileSpecs.Count) profiles, $($boardSpecs.Count) boards, local-only flags enforced."
