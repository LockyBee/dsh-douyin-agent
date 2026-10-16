param(
  [string]$DshRoot = 'F:\codex\DSH Desktop 2',
  [string]$Node = '',
  [switch]$Install
)
$ErrorActionPreference = 'Stop'
$dshDirectory = (Resolve-Path -LiteralPath $DshRoot).Path
$cli = Join-Path $dshDirectory 'resources\app\lib\desktop-cli.js'
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw '此目录没有当前 DSH CLI，请指定你正在使用的 DSH 安装目录。' }
if (-not $Node) { $Node = Join-Path $PSScriptRoot 'desktop\.cache\generated\node\node.exe' }
if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { $Node = (Get-Command node -ErrorAction Stop).Source }
$nodeExecutable = (Resolve-Path -LiteralPath $Node).Path
$package = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
$homeDirectory = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDirectory = Join-Path $homeDirectory 'profiles\desktop'
$profilePackage = Join-Path $profileDirectory 'package.json'
if (-not (Test-Path -LiteralPath $profilePackage -PathType Leaf)) { throw '请先用你正在使用的 DSH Desktop 初始化 desktop profile。' }
$plan = [ordered]@{ package=$package.name; version=$package.version; dshRoot=$dshDirectory; profile='desktop'; settings='设置 → 刷抖音'; changes=@('安装本地标准插件 bundle 与原生设置入口','成功后仅移除旧安装器管理的全局 douyin-browser 区块'); applied=$false }
if (-not $Install) { $plan | ConvertTo-Json -Depth 5; Write-Output '检查完成。完全退出当前 DSH 后，加 -Install 才会安装；本次没有改配置或启动软件。'; exit 0 }
$targetExe = Join-Path $dshDirectory 'DSH Desktop.exe'
$running = Get-CimInstance Win32_Process -Filter "Name = 'DSH Desktop.exe'" | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath,$targetExe,[StringComparison]::OrdinalIgnoreCase) }
if ($running) { throw '请完全退出这个目录的 DSH 后再安装，避免运行中修改 profile。脚本不会代你关闭窗口。' }
& $nodeExecutable (Join-Path $PSScriptRoot 'plugin-install.mjs') --dry-run --home $homeDirectory
if ($LASTEXITCODE -ne 0) { throw '旧加载配置存在冲突或无法核对，未开始安装标准 bundle。' }
$backupDirectory = Join-Path $PSScriptRoot ('state\native-install-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
foreach ($name in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.patch.yml')) {
  $file = Join-Path $profileDirectory $name
  if (Test-Path -LiteralPath $file -PathType Leaf) { Copy-Item -LiteralPath $file -Destination (Join-Path $backupDirectory $name) }
}
$legacyPatch = Join-Path $homeDirectory 'cordis.patch.yml'
if (Test-Path -LiteralPath $legacyPatch -PathType Leaf) { Copy-Item -LiteralPath $legacyPatch -Destination (Join-Path $backupDirectory 'home-cordis.patch.yml') }
Push-Location -LiteralPath $PSScriptRoot
try {
  & $nodeExecutable $cli plugin --profile desktop add ('link:' + $PSScriptRoot)
  if ($LASTEXITCODE -ne 0) { throw ('DSH 插件管理未成功，保留旧加载项。安装前配置副本：' + $backupDirectory) }
  & $nodeExecutable (Join-Path $PSScriptRoot 'plugin-install.mjs') --uninstall --home $homeDirectory
  if ($LASTEXITCODE -ne 0) { throw ('标准 bundle 已安装，但旧管理区块迁移未完成，请勿重复安装。配置副本：' + $backupDirectory) }
} finally { Pop-Location }
$plan.applied = $true
$plan.backupDirectory = $backupDirectory
$plan | ConvertTo-Json -Depth 5
Write-Output '安装命令已完成；重新打开同一目录的 DSH，在“设置 → 刷抖音”检查入口。实际加载状态仍以界面和日志为准。'
