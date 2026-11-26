param([switch]$SetupOnly, [switch]$Check)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
try {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodePath = if ($nodeCommand) { $nodeCommand.Source } else { '' }
    if ($nodePath) { $version = & $nodePath -p 'parseInt(process.versions.node)'; if ([int]$version -lt 22) { $nodePath = '' } }
    if (!$nodePath) {
        $nodePath = Join-Path (Get-Location) '.runtime\node-v22.23.5-win-x64\node.exe'
        if (!(Test-Path -LiteralPath $nodePath)) {
            if ($Check) { throw 'Node.js is not ready. Run start.cmd with internet access for first-time setup.' }
            if (![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'Automatic setup supports Windows x64. Install Node.js 22 or newer for your platform.' }
            Write-Host 'Downloading Node.js into this project folder (no system installation).'
            New-Item -ItemType Directory -Force -Path '.runtime' | Out-Null
            $zip = Join-Path (Get-Location) '.runtime\node.zip'
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/v22.23.5/node-v22.23.5-win-x64.zip' -OutFile $zip
            if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne '4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3') { throw 'Node.js download failed its integrity check. Retry start.cmd.' }
            Expand-Archive -LiteralPath $zip -DestinationPath '.runtime' -Force
            Remove-Item -LiteralPath $zip
        }
    }
    $nodeDirectory = Split-Path -Parent $nodePath
    $env:PATH = "$nodeDirectory;$env:PATH"
    $stamp = 'node_modules\.facade-lock'
    $hash = (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash
    if (!(Test-Path $stamp) -or (Get-Content $stamp -Raw).Trim() -ne $hash) {
        if ($Check) { throw 'Dependencies are not ready. Run start.cmd with internet access for first-time setup.' }
        & (Join-Path $nodeDirectory 'npm.cmd') ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check internet access and try again.' }
        Set-Content -LiteralPath $stamp -Value $hash -Encoding ASCII
    }
    if (!(Test-Path 'public\connector.zip')) { & $nodePath scripts/build-connector.cjs; if ($LASTEXITCODE -ne 0) { throw 'Could not package the browser connector.' } }
    if ($SetupOnly -or $Check) { Write-Host 'Node.js, dependencies and connector package are ready.'; exit 0 }
    $env:FACADE_OPEN_BROWSER = '1'
    Write-Host 'Keep this window open while using the portal. Press Ctrl+C to stop.'
    & $nodePath server/index.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Server stopped. Check whether port 4070 is already in use.' }
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
