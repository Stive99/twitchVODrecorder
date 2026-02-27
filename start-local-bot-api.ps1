param(
	[int]$Port = 8081,
	[string]$WorkDir = '.botapi'
)

$ErrorActionPreference = 'Stop'

if ((-not $env:TELEGRAM_API_ID -or -not $env:TELEGRAM_API_HASH) -and (Test-Path '.env')) {
	Get-Content '.env' | ForEach-Object {
		$line = $_.Trim()
		if (-not $line -or $line.StartsWith('#') -or -not $line.Contains('=')) {
			return
		}
		$key, $value = $line.Split('=', 2)
		$key = $key.Trim()
		$value = $value.Trim()
		if (-not $key) {
			return
		}
		if (-not (Test-Path "env:$key")) {
			Set-Item -Path "env:$key" -Value $value
		}
	}
}

if (-not $env:TELEGRAM_API_ID) {
	throw 'TELEGRAM_API_ID is required to run local telegram-bot-api.'
}
if (-not $env:TELEGRAM_API_HASH) {
	throw 'TELEGRAM_API_HASH is required to run local telegram-bot-api.'
}

$binaryName = if ($env:BOT_API_LOCAL_BIN) { $env:BOT_API_LOCAL_BIN } else { 'telegram-bot-api' }
$binary = Get-Command $binaryName -ErrorAction SilentlyContinue
if (-not $binary) {
	throw "telegram-bot-api binary was not found in PATH. Set BOT_API_LOCAL_BIN or install '$binaryName'."
}

$resolvedWorkDir = Resolve-Path -Path $WorkDir -ErrorAction SilentlyContinue
if (-not $resolvedWorkDir) {
	New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
	$resolvedWorkDir = Resolve-Path -Path $WorkDir
}

Write-Host "Starting local telegram-bot-api on port $Port"
Write-Host "Workdir: $resolvedWorkDir"

$args = @(
	'--api-id', $env:TELEGRAM_API_ID,
	'--api-hash', $env:TELEGRAM_API_HASH,
	'--local',
	'--http-port', "$Port",
	'--dir', "$resolvedWorkDir"
)

& $binary.Source @args
