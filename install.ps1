param([ValidateSet('install','status')][string]$Action = 'install')
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'skill\SKILL.md'
$target = Join-Path $env:USERPROFILE '.dsh\skills\dsh-douyin\SKILL.md'
$state = Join-Path $PSScriptRoot 'state'
$record = Join-Path $state 'install.json'
if ($Action -eq 'status') {
    [pscustomobject]@{installed=(Test-Path -LiteralPath $target); skill=$target; matchesSource=((Test-Path -LiteralPath $target) -and ((Get-FileHash -LiteralPath $source).Hash -eq (Get-FileHash -LiteralPath $target).Hash))} | ConvertTo-Json
    exit 0
}
New-Item -ItemType Directory -Path $state -Force | Out-Null
$backup = $null
if (Test-Path -LiteralPath $target) {
    if ((Get-FileHash -LiteralPath $source).Hash -eq (Get-FileHash -LiteralPath $target).Hash) {
        Write-Output '技能已安装，内容与源码一致。'
        exit 0
    }
    $backup = Join-Path $state ('SKILL-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.md')
    Copy-Item -LiteralPath $target -Destination $backup
}
New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $target
[pscustomobject]@{installed=$true;skill=$target;backup=$backup;hash=(Get-FileHash -LiteralPath $target).Hash;time=(Get-Date -Format o)} | ConvertTo-Json | Set-Content -LiteralPath $record -Encoding utf8
Write-Output 'DSH 抖音技能已安装。'
