# dsh-style-memory installer: adds this package to the DSH desktop profile.
$ErrorActionPreference = "Stop"
$pluginDir = $PSScriptRoot

$requiredFiles = @("package.json", "index.js", "client.js", "cordis.patch.yml")
foreach ($requiredName in $requiredFiles) {
  $requiredPath = Join-Path $pluginDir $requiredName
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw ("插件目录不完整，缺少 " + $requiredName + "：" + $pluginDir)
  }
}

$bundledCli = Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$dshCli = $null
if (Test-Path -LiteralPath $bundledCli) {
  $dshCli = $bundledCli
} else {
  $dshCommand = Get-Command dsh -ErrorAction SilentlyContinue
  if ($dshCommand) { $dshCli = $dshCommand.Source }
}
if (-not $dshCli) {
  $manualCommand = 'dsh plugin --profile desktop add "' + $pluginDir + '"'
  throw ("未找到 dsh CLI。手动执行：" + $manualCommand)
}

Write-Host ("插件目录：" + $pluginDir)
Write-Host ("使用 CLI：" + $dshCli)
& $dshCli plugin --profile desktop add $pluginDir
if ($LASTEXITCODE -ne 0) {
  throw ("安装失败（exit " + $LASTEXITCODE + "）")
}

$backupRoot = Join-Path $env:USERPROFILE ".dsh\local-plugins"
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$backupDir = Join-Path $backupRoot ("dsh-style-memory-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
Copy-Item -LiteralPath $pluginDir -Destination $backupDir -Recurse -Force
Compress-Archive -LiteralPath $backupDir -DestinationPath ($backupDir + ".zip") -Force
Write-Host ("源目录已备份：" + $backupDir + ".zip")

$dataDir = Join-Path $env:USERPROFILE ".dsh\style-memory"
Write-Host ""
Write-Host "安装完成，已写入 desktop profile。"
Write-Host "重启 DeepSeek Harness 后生效，插件管理页显示「风格记忆 / Style Memory」。"
Write-Host ("数据目录在首次写档案时自动创建：" + $dataDir)
Write-Host "验证：重启后输入 /style，应返回当前状态。"
