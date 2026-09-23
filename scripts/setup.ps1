# One-time setup: creates a venv and installs dependencies.
$root = Join-Path $PSScriptRoot ".."
python -m venv (Join-Path $root ".venv")
& (Join-Path $root ".venv\Scripts\Activate.ps1")
pip install --upgrade pip
pip install -r (Join-Path $root "requirements.txt")

if (-not (Test-Path (Join-Path $root ".env"))) {
    Copy-Item (Join-Path $root ".env.example") (Join-Path $root ".env")
    Write-Host "Created .env from .env.example - edit it and set AZURE_API_KEY before running." -ForegroundColor Yellow
}
