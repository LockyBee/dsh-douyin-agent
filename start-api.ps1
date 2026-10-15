param([int]$Port = $(if ($env:DOUYIN_API_PORT) { $env:DOUYIN_API_PORT } else { 3218 }), [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
if ($Port -lt 1024 -or $Port -gt 65535) { throw '端口必须是 1024 至 65535 的整数。' }
$consoleUrl = "http://127.0.0.1:$Port"
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw '找不到 Node.js。请先安装 Node.js 22.13 或以上版本。' }
$nodeVersion = & $nodeCommand.Source -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^(\d+)\.(\d+)\.') { throw '无法读取 Node.js 版本。' }
if ([int]$Matches[1] -lt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -lt 13)) { throw '需要 Node.js 22.13 或以上版本，以读取共享 SQLite 记忆。' }
$healthy = $false
try {
  $response = Invoke-RestMethod -Uri "$consoleUrl/api/bootstrap" -TimeoutSec 2 -MaximumRedirection 0
  $healthy = ($response.service -eq 'douyin-api-local' -and $response.version -eq 1 -and $null -ne $response.config.model -and $null -ne $response.token)
} catch {}
if (-not $healthy) {
  $stateDir = Join-Path $appRoot 'state'
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  $suffix = if ($Port -eq 3218) { '' } else { "-$Port" }
  $logFile = Join-Path $stateDir "api-server$suffix.log"
  $errorFile = Join-Path $stateDir "api-server-error$suffix.log"
  $appFile = Join-Path $appRoot 'app.mjs'
  $previousPort = $env:DOUYIN_API_PORT
  try {
    $env:DOUYIN_API_PORT = [string]$Port
    $process = Start-Process -FilePath $nodeCommand.Source -ArgumentList @("`"$appFile`"") -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError $errorFile -PassThru
  } finally {
    if ($null -eq $previousPort) { Remove-Item Env:DOUYIN_API_PORT -ErrorAction SilentlyContinue } else { $env:DOUYIN_API_PORT = $previousPort }
  }
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    if ($process.HasExited) { throw "本机服务启动失败，请查看 $errorFile" }
    try {
      $response = Invoke-RestMethod -Uri "$consoleUrl/api/bootstrap" -TimeoutSec 1 -MaximumRedirection 0
      if ($response.service -eq 'douyin-api-local' -and $response.version -eq 1 -and $null -ne $response.config.model -and $null -ne $response.token) { $healthy = $true; break }
    } catch {}
  }
  if (-not $healthy) { throw "本机服务没有就绪，请查看 $errorFile" }
  Set-Content -LiteralPath (Join-Path $stateDir "api-server$suffix.pid") -Value $process.Id -Encoding ascii
}
Write-Host "DeepSeek 抖音浏览台：$consoleUrl"
if (-not $NoOpen) { Start-Process $consoleUrl }
