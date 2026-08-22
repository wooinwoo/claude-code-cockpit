[CmdletBinding()]
param(
    [string]$HermesRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'hermes')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$HermesRoot = [IO.Path]::GetFullPath($HermesRoot)
$runtimeProvider = Join-Path $HermesRoot 'hermes-agent\hermes_cli\runtime_provider.py'
$appServerClient = Join-Path $HermesRoot 'hermes-agent\agent\transports\codex_app_server.py'
$codexRuntime = Join-Path $HermesRoot 'hermes-agent\agent\codex_runtime.py'
$hermesExeCandidates = @(
    (Join-Path $HermesRoot 'hermes-agent\venv\Scripts\hermes.exe'),
    (Join-Path $HermesRoot 'hermes-agent\bin\hermes.exe')
)
$hermesExe = $hermesExeCandidates | Where-Object {
    Test-Path -LiteralPath $_ -PathType Leaf
} | Select-Object -First 1

if (-not $hermesExe) {
    throw "Hermes executable not found under '$HermesRoot'."
}
if (-not (Test-Path -LiteralPath $runtimeProvider -PathType Leaf)) {
    throw "Hermes runtime provider not found: $runtimeProvider"
}
if (-not (Test-Path -LiteralPath $appServerClient -PathType Leaf)) {
    throw "Hermes Codex app-server client not found: $appServerClient"
}
if (-not (Test-Path -LiteralPath $codexRuntime -PathType Leaf)) {
    throw "Hermes Codex runtime not found: $codexRuntime"
}

$version = (& $hermesExe --version 2>&1) -join [Environment]::NewLine
if ($LASTEXITCODE -ne 0 -or $version -notmatch 'Hermes Agent v0\.20\.5\b') {
    throw "Praetorium's Codex runtime bridge is pinned to Hermes Agent v0.20.5; got: $version"
}

$marker = 'PRAETORIUM_CODEX_APP_SERVER_AUTH_BRIDGE_V1'
$source = [IO.File]::ReadAllText($runtimeProvider)
if (-not $source.Contains($marker)) {
    $needle = '    requested_provider = resolve_requested_provider(requested)'
    $matches = ([regex]::Matches($source, [regex]::Escape($needle))).Count
    if ($matches -ne 1) {
        throw "Hermes source layout changed: expected exactly one runtime-provider insertion point, found $matches."
    }

# Hermes v0.20.5 resolves an openai-codex OAuth token before applying its
# codex_app_server transport override. That token is never used by the selected
# transport: `codex app-server` authenticates through the Codex CLI's own local
# login. This narrowly-scoped bridge returns a virtual runtime only when the
# profile explicitly opted into codex_app_server. The marker never enters the
# child environment or a network request; if Codex is logged out, app-server
# itself fails closed with its normal authentication error.
$bridge = @'


    # PRAETORIUM_CODEX_APP_SERVER_AUTH_BRIDGE_V1
    # `codex app-server` owns authentication through the local Codex CLI. Avoid
    # requiring a redundant Hermes OAuth token before that stdio child starts.
    _praetorium_model_cfg = _get_model_config()
    if (
        requested_provider in {"openai", "openai-codex"}
        and str(_praetorium_model_cfg.get("openai_runtime") or "").strip().lower()
        == "codex_app_server"
    ):
        return {
            "provider": "openai-codex",
            "api_mode": "codex_app_server",
            "base_url": DEFAULT_CODEX_BASE_URL,
            "api_key": "praetorium-local-codex-app-server",
            "source": "codex-cli-local-auth",
            "requested_provider": requested_provider,
        }
'@

    $patched = $source.Replace($needle, $needle + $bridge)
    [IO.File]::WriteAllText($runtimeProvider, $patched, [Text.UTF8Encoding]::new($false))
    Write-Host 'Installed Hermes Codex app-server authentication bridge.'
} else {
    Write-Host 'Hermes Codex app-server authentication bridge is already installed.'
}

# The upstream v0.20.5 app-server client adds the Kanban DB writable root only
# for dispatched workers. A semantic Director also writes the active board,
# but has HERMES_KANBAN_BOARD rather than HERMES_KANBAN_TASK. Expand that one
# guard and keep the same upstream workspace-write + network-off overrides.
$boardMarker = 'PRAETORIUM_DIRECTOR_BOARD_ROOT_BRIDGE_V1'
$appServerSource = [IO.File]::ReadAllText($appServerClient)
if (-not $appServerSource.Contains($boardMarker)) {
    $appServerNeedle = '        if spawn_env.get("HERMES_KANBAN_TASK"):'
    $appServerMatches = ([regex]::Matches($appServerSource, [regex]::Escape($appServerNeedle))).Count
    if ($appServerMatches -ne 1) {
        throw "Hermes source layout changed: expected exactly one app-server Kanban guard, found $appServerMatches."
    }
    $appServerReplacement = @'
        # PRAETORIUM_DIRECTOR_BOARD_ROOT_BRIDGE_V1
        if spawn_env.get("HERMES_KANBAN_TASK") or spawn_env.get("HERMES_KANBAN_BOARD"):
'@
    $appServerPatched = $appServerSource.Replace($appServerNeedle, $appServerReplacement.TrimEnd())
    [IO.File]::WriteAllText($appServerClient, $appServerPatched, [Text.UTF8Encoding]::new($false))
    Write-Host 'Installed Hermes Director board-root sandbox bridge.'
} else {
    Write-Host 'Hermes Director board-root sandbox bridge is already installed.'
}

# Codex parses `-c` values as TOML. Raw Windows backslashes make the writable
# roots array fall back to a string value, which app-server rejects during
# initialize. Forward slashes are valid native Windows paths and valid TOML.
$windowsPathMarker = 'PRAETORIUM_WINDOWS_TOML_ROOT_BRIDGE_V1'
$appServerSource = [IO.File]::ReadAllText($appServerClient)
if (-not $appServerSource.Contains($windowsPathMarker)) {
    $pathNeedle = '            app_server_args.extend('
    $pathMatches = ([regex]::Matches($appServerSource, [regex]::Escape($pathNeedle))).Count
    if ($pathMatches -ne 1) {
        throw "Hermes source layout changed: expected exactly one app-server argument insertion point, found $pathMatches."
    }
    $pathReplacement = @'
            # PRAETORIUM_WINDOWS_TOML_ROOT_BRIDGE_V1
            kanban_root = str(kanban_root).replace("\\", "/")
            app_server_args.extend(
'@
    $pathPatched = $appServerSource.Replace($pathNeedle, $pathReplacement.TrimEnd())
    [IO.File]::WriteAllText($appServerClient, $pathPatched, [Text.UTF8Encoding]::new($false))
    Write-Host 'Installed Hermes Windows writable-root TOML bridge.'
} else {
    Write-Host 'Hermes Windows writable-root TOML bridge is already installed.'
}

# Hermes profiles have a static terminal.cwd fallback. A project Director is
# selected dynamically by Praetorium, so that static value must not decide the
# Codex app-server thread root. The parent supplies this absolute path in the
# child environment; this pinned bridge gives it precedence without enabling
# any broader sandbox or network permission.
$projectCwdMarker = 'PRAETORIUM_PROJECT_CWD_BRIDGE_V1'
$codexRuntimeSource = [IO.File]::ReadAllText($codexRuntime)
if (-not $codexRuntimeSource.Contains($projectCwdMarker)) {
    $cwdNeedle = '        cwd = getattr(agent, "session_cwd", None) or str(resolve_agent_cwd())'
    $cwdMatches = ([regex]::Matches($codexRuntimeSource, [regex]::Escape($cwdNeedle))).Count
    if ($cwdMatches -ne 1) {
        throw "Hermes source layout changed: expected exactly one Codex runtime cwd assignment, found $cwdMatches."
    }
    $cwdReplacement = @'
        # PRAETORIUM_PROJECT_CWD_BRIDGE_V1
        import os as _praetorium_os

        cwd = (
            _praetorium_os.environ.get("PRAETORIUM_PROJECT_CWD")
            or getattr(agent, "session_cwd", None)
            or str(resolve_agent_cwd())
        )
'@
    $codexRuntimePatched = $codexRuntimeSource.Replace($cwdNeedle, $cwdReplacement.TrimEnd())
    [IO.File]::WriteAllText($codexRuntime, $codexRuntimePatched, [Text.UTF8Encoding]::new($false))
    Write-Host 'Installed Hermes project-scoped Codex cwd bridge.'
} else {
    Write-Host 'Hermes project-scoped Codex cwd bridge is already installed.'
}
