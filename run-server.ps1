param(
  # Optional switch. Omit it for a normal start. Use -UnpairAll to run unpair-all once
  # before the server (e.g. so the next clean boot can show a fresh invite).
  [switch]$UnpairAll
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "Starting KeepSync server..." -ForegroundColor Cyan

# Ensure Go is installed
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
  Write-Error "Go is not installed or not in PATH. Install Go 1.21+ and reopen PowerShell."
}

# Ensure modules are enabled
go env -w GO111MODULE=on | Out-Null

# Require Go 1.21+ for modernc.org/sqlite
$versionLine = (go version) 2>$null
if (-not $versionLine) {
  Write-Error "Go is not installed or not in PATH."
}
if ($versionLine -match "go([0-9]+)\.([0-9]+)") {
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  if ($major -lt 1 -or ($major -eq 1 -and $minor -lt 21)) {
    Write-Error "Go 1.21+ is required. Detected: $versionLine"
  }
}

# Ensure .env exists - copy from example and inject a random JWT_SECRET if missing
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $repoRoot ".env"
$exampleFile = Join-Path $repoRoot ".env.example"

if (-not (Test-Path $envFile)) {
  if (Test-Path $exampleFile) {
    Write-Host "No .env found - creating from .env.example with a generated JWT_SECRET..." -ForegroundColor Yellow
    $example = Get-Content $exampleFile -Raw
    # Generate a 48-character hex secret
    $secret = -join ((1..48) | ForEach-Object { '{0:x2}' -f (Get-Random -Minimum 0 -Maximum 256) })
    $example = $example -replace 'JWT_SECRET=your-super-secret-jwt-key-minimum-32-characters-long', "JWT_SECRET=$secret"
    # Uncomment localhost dev lines for convenience
    $example = $example -replace '# DOMAIN=localhost:8787', 'DOMAIN=localhost:8787'
    $example = $example -replace '# ALLOWED_ORIGINS=\*', 'ALLOWED_ORIGINS=*'
    $example = $example -replace '# DEV_MODE=true', 'DEV_MODE=true'
    [System.IO.File]::WriteAllText($envFile, $example, [System.Text.UTF8Encoding]::new($false))
    Write-Host ".env created. JWT_SECRET set automatically." -ForegroundColor Green
  } else {
    Write-Error ".env.example not found - cannot auto-create .env"
  }
}

# Run from server module directory
$serverDir = Join-Path $repoRoot "server"
Set-Location -Path $serverDir

if ($UnpairAll) {
  Write-Host "UnpairAll: revoking all devices in the database..." -ForegroundColor Yellow
  go run ./cmd unpair-all
}

go run ./cmd
