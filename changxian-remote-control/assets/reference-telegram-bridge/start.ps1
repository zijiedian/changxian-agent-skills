param(
    [string]$Token,
    [string]$Host,
    [int]$Port = 18000,
    [ValidateSet('auto', 'python', 'binary')]
    [string]$Mode = 'auto',
    [switch]$Reload,
    [ValidateSet('critical', 'error', 'warning', 'info', 'debug', 'trace')]
    [string]$LogLevel = 'info',
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$startPy = Join-Path $scriptDir 'start.py'
$forwardArgs = @('--port', [string]$Port, '--mode', $Mode, '--log-level', $LogLevel)

if ($Token) {
    $forwardArgs += @('--token', $Token)
}
if ($Host) {
    $forwardArgs += @('--host', $Host)
}
if ($Reload) {
    $forwardArgs += '--reload'
}
if ($RemainingArgs) {
    $forwardArgs += $RemainingArgs
}

$venvPython = Join-Path $scriptDir '.venv\Scripts\python.exe'
if (Test-Path $venvPython) {
    & $venvPython $startPy @forwardArgs
    exit $LASTEXITCODE
}

$pyLauncher = Get-Command py -ErrorAction SilentlyContinue
if ($pyLauncher) {
    & $pyLauncher.Source -3 $startPy @forwardArgs
    exit $LASTEXITCODE
}

$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if ($pythonCmd) {
    & $pythonCmd.Source $startPy @forwardArgs
    exit $LASTEXITCODE
}

Write-Error 'Python 3 was not found. Install Python 3, or use the prebuilt remote-control release zip.'
exit 1
