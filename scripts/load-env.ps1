# Dot-source this to load .env into the current PowerShell process's
# environment: . .\scripts\load-env.ps1
$envFile = Join-Path $PSScriptRoot "..\.env"
if (-not (Test-Path $envFile)) {
    Write-Warning ".env not found at $envFile - copy .env.example to .env and fill in AZURE_API_KEY first."
    return
}
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    $parts = $line -split "=", 2
    if ($parts.Length -eq 2) {
        [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim())
    }
}
