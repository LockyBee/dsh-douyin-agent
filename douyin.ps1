param(
    [Parameter(Position=0)][string]$Action = 'help',
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$BrowserArgs
)
$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (!$nodeCommand) { throw '找不到 Node.js，请先安装 22.13 或以上版本。' }
Push-Location -LiteralPath $PSScriptRoot
try {
    & $nodeCommand.Source (Join-Path $PSScriptRoot 'control.mjs') $Action @BrowserArgs
    $browserExit = $LASTEXITCODE
} finally { Pop-Location }
exit $browserExit
