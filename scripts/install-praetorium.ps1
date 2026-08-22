[CmdletBinding()]
param(
    [string]$ProjectsRoot = 'C:\projects',
    [string]$Repository = 'wooinwoo/claude-code-cockpit',
    [string]$Version = 'v2.0.0',
    [string]$SourceRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Praetorium\source'),
    [switch]$SkipAppInstall,
    [switch]$SkipLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$HermesTag = 'v2026.8.19'
$HermesVersion = 'Hermes Agent v0.20.5'
$HermesInstallerUrl = "https://raw.githubusercontent.com/NousResearch/hermes-agent/$HermesTag/install.ps1"
$HermesInstallerSha256 = '74225BF244253BFA5BC2B1D16FA3BB8618E199A53D1C0344B37AB9930696D3BA'
$CodexVersion = '0.149.0'

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machine, $user, $env:Path) -join ';'
}

function Get-Application {
    param([Parameter(Mandatory)][string]$Name)
    Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Ensure-WingetPackage {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string]$PackageId
    )
    if (Get-Application $Command) { return }
    if (-not (Get-Application 'winget.exe')) {
        throw "'$Command' is required and winget is unavailable. Install $PackageId, then rerun."
    }
    Write-Step "Installing $PackageId"
    & winget.exe install --id $PackageId -e --source winget --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) { throw "winget failed to install $PackageId ($LASTEXITCODE)." }
    Refresh-ProcessPath
    if (-not (Get-Application $Command)) { throw "$PackageId installed, but '$Command' is still unavailable. Open a new PowerShell and rerun." }
}

function Get-HermesExecutable {
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    $candidates = @(
        (Join-Path $local 'hermes\hermes-agent\venv\Scripts\hermes.exe'),
        (Join-Path $local 'hermes\hermes-agent\bin\hermes.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Install-Hermes {
    $hermes = Get-HermesExecutable
    if ($hermes) {
        $current = (& $hermes --version 2>&1) -join [Environment]::NewLine
        if ($LASTEXITCODE -eq 0 -and $current -match [regex]::Escape($HermesVersion)) {
            Write-Host "Hermes already pinned: $HermesVersion"
            return $hermes
        }
    }

    Write-Step "Installing pinned Hermes $HermesTag (local CLI only)"
    $download = Join-Path ([IO.Path]::GetTempPath()) "praetorium-hermes-$HermesTag.ps1"
    Invoke-WebRequest -UseBasicParsing -Uri $HermesInstallerUrl -OutFile $download
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash
    if ($actualHash -ne $HermesInstallerSha256) {
        throw "Hermes installer checksum mismatch. Expected $HermesInstallerSha256, got $actualHash."
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $download -Tag $HermesTag -SkipSetup -SkipComputerUse -NonInteractive
    if ($LASTEXITCODE -ne 0) { throw "Hermes install failed ($LASTEXITCODE)." }
    $hermes = Get-HermesExecutable
    if (-not $hermes) { throw 'Hermes installed, but hermes.exe was not found.' }
    $installedVersion = (& $hermes --version 2>&1) -join [Environment]::NewLine
    if ($installedVersion -notmatch [regex]::Escape($HermesVersion)) {
        throw "Unexpected Hermes version: $installedVersion"
    }
    return $hermes
}

function Sync-Source {
    Write-Step "Syncing Praetorium source $Version"
    $parent = Split-Path -Parent $SourceRoot
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    if (Test-Path -LiteralPath (Join-Path $SourceRoot '.git') -PathType Container) {
        & git.exe -C $SourceRoot fetch origin --tags --prune
        if ($LASTEXITCODE -ne 0) { throw 'git fetch failed.' }
        & git.exe -C $SourceRoot checkout --detach $Version
        if ($LASTEXITCODE -ne 0) { throw "git checkout $Version failed." }
    } elseif (Test-Path -LiteralPath $SourceRoot) {
        throw "SourceRoot exists but is not a Git repository: $SourceRoot"
    } else {
        & git.exe clone --branch $Version --depth 1 "https://github.com/$Repository.git" $SourceRoot
        if ($LASTEXITCODE -ne 0) { throw 'git clone failed.' }
    }
}

function Install-Codex {
    if (-not (Get-Application 'codex.exe')) {
        Write-Step "Installing Codex CLI $CodexVersion"
        & npm.cmd install --global "@openai/codex@$CodexVersion"
        if ($LASTEXITCODE -ne 0) { throw "Codex CLI install failed ($LASTEXITCODE)." }
        Refresh-ProcessPath
    }
    if (-not (Get-Application 'codex.exe')) { throw 'codex.exe is unavailable after installation.' }

    & codex.exe login status
    if ($LASTEXITCODE -ne 0) {
        Write-Step 'One-time Codex account login (the only required interactive step)'
        & codex.exe login
        if ($LASTEXITCODE -ne 0) { throw 'Codex login did not complete.' }
    }
}

function Install-PraetoriumApp {
    Write-Step "Downloading checksummed GitHub release assets for $Version"
    $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'Praetorium-Installer' }
    $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repository/releases/tags/$Version"
    $installerAsset = $release.assets | Where-Object { $_.name -match '^Praetorium_.*_x64-setup\.exe$' } | Select-Object -First 1
    if (-not $installerAsset) { throw "Windows x64 installer not found in release $Version." }
    $checksumAsset = $release.assets | Where-Object { $_.name -eq "$($installerAsset.name).sha256" } | Select-Object -First 1
    if (-not $checksumAsset) { throw "Checksum asset missing for $($installerAsset.name)." }

    $downloadDir = Join-Path ([IO.Path]::GetTempPath()) "praetorium-$Version"
    [IO.Directory]::CreateDirectory($downloadDir) | Out-Null
    $installerPath = Join-Path $downloadDir $installerAsset.name
    $checksumPath = "$installerPath.sha256"
    Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $installerAsset.browser_download_url -OutFile $installerPath
    Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $checksumAsset.browser_download_url -OutFile $checksumPath
    $expected = ((Get-Content -Raw -LiteralPath $checksumPath).Trim() -split '\s+')[0].ToUpperInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath).Hash
    if ($actual -ne $expected) { throw "Praetorium installer checksum mismatch. Expected $expected, got $actual." }

    Write-Step 'Installing Praetorium for the current Windows user'
    $process = Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Praetorium installer failed ($($process.ExitCode))." }
}

function Start-And-VerifyPraetorium {
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    $candidates = @(
        (Join-Path $local 'Praetorium\praetorium.exe'),
        (Join-Path $local 'Praetorium\Praetorium.exe')
    )
    $app = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $app) { throw 'Praetorium executable was not found after installation.' }
    Start-Process -FilePath $app

    $health = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3847/api/health' -TimeoutSec 2
            break
        } catch { }
    }
    if (-not $health -or $health.status -ne 'ok') { throw 'Praetorium did not become healthy on loopback port 3847.' }

    $listeners = @(Get-NetTCPConnection -LocalPort 3847 -State Listen -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) { throw 'Praetorium health passed, but no listening socket was found.' }
    $unsafe = @($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
    if ($unsafe.Count) { throw "Unsafe non-loopback listener detected: $($unsafe.LocalAddress -join ', ')" }
    Write-Host 'Verified: Praetorium listens only on loopback and reports healthy.' -ForegroundColor Green
}

if ($env:OS -ne 'Windows_NT') { throw 'This installer currently supports Windows only.' }

Write-Step 'Checking prerequisites'
Ensure-WingetPackage -Command 'git.exe' -PackageId 'Git.Git'
Ensure-WingetPackage -Command 'node.exe' -PackageId 'OpenJS.NodeJS.LTS'
Refresh-ProcessPath
if (-not (Get-Application 'npm.cmd')) { throw 'npm.cmd is required but unavailable.' }

[IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($ProjectsRoot)) | Out-Null
$ProjectsRoot = [IO.Path]::GetFullPath($ProjectsRoot)
$env:PRAETORIUM_PROJECTS_ROOT = $ProjectsRoot
$env:COCKPIT_PROJECTS_ROOT = $ProjectsRoot
[Environment]::SetEnvironmentVariable('PRAETORIUM_PROJECTS_ROOT', $ProjectsRoot, 'User')
[Environment]::SetEnvironmentVariable('COCKPIT_PROJECTS_ROOT', $ProjectsRoot, 'User')

Install-Codex
$hermes = Install-Hermes
Sync-Source

Write-Step 'Installing Directors, workers, review skills, and local-only policy'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $SourceRoot 'scripts\bootstrap-director-system.ps1') -HermesExecutable $hermes -DefaultWorkdir $ProjectsRoot
if ($LASTEXITCODE -ne 0) { throw "Director bootstrap failed ($LASTEXITCODE)." }

if (-not $SkipAppInstall) { Install-PraetoriumApp }
if (-not $SkipLaunch -and -not $SkipAppInstall) { Start-And-VerifyPraetorium }

Write-Host "`nPraetorium $Version is ready." -ForegroundColor Green
Write-Host "Projects root: $ProjectsRoot"
Write-Host 'Network policy: local loopback only; no gateway, daemon, webhook, LAN, Tailscale, or messaging bridge was started.'
