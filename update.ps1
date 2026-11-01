# dsh-style-memory update: syntax check, tests, profile link check, restart hint.
$ErrorActionPreference = "Stop"
$pluginDir = $PSScriptRoot

$packagePath = Join-Path $pluginDir "package.json"
if (-not (Test-Path -LiteralPath $packagePath)) {
  throw ("找不到 package.json：" + $packagePath)
}
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$version = $package.version
Write-Host ("dsh-style-memory " + $version + " - update")

$nodeCli = $null
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
  $nodeCli = $nodeCommand.Source
} else {
  $bundledNode = Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness\resources\runtime\bin\node.cmd"
  if (Test-Path -LiteralPath $bundledNode) { $nodeCli = $bundledNode }
}
if (-not $nodeCli) {
  throw "未找到 node。请安装 Node.js，或用 DSH 自带运行时执行语法检查与测试。"
}
$backupRoot = Join-Path $env:USERPROFILE ".dsh\local-plugins"
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$backupDir = Join-Path $backupRoot ("dsh-style-memory-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
Copy-Item -LiteralPath $pluginDir -Destination $backupDir -Recurse -Force
Compress-Archive -LiteralPath $backupDir -DestinationPath ($backupDir + ".zip") -Force
Write-Host ("源备份：" + $backupDir + ".zip")

Write-Host ("node：" + $nodeCli)
Write-Host ""

Write-Host "[1/4] 语法检查"
$jsFiles = @()
$entryPath = Join-Path $pluginDir "index.js"
if (Test-Path -LiteralPath $entryPath) { $jsFiles += $entryPath }
$clientPath = Join-Path $pluginDir "client.js"
if (Test-Path -LiteralPath $clientPath) { $jsFiles += $clientPath }
foreach ($folderName in @("lib", "scripts", "test")) {
  $folderPath = Join-Path $pluginDir $folderName
  if (Test-Path -LiteralPath $folderPath) {
    $allFiles = Get-ChildItem -LiteralPath $folderPath -Recurse -File
    foreach ($candidateFile in $allFiles) {
      if ($candidateFile.Extension -eq ".js" -or $candidateFile.Extension -eq ".mjs") {
        $jsFiles += $candidateFile.FullName
      }
    }
  }
}
if ($jsFiles.Count -eq 0) {
  throw "没有找到可检查的 JS 文件，插件目录可能不完整。"
}
foreach ($jsFile in $jsFiles) {
  & $nodeCli --check $jsFile
  if ($LASTEXITCODE -ne 0) {
    throw ("语法错误：" + $jsFile)
  }
}
Write-Host ("  " + $jsFiles.Count + " 个文件通过")

Write-Host "[2/4] 单元测试"
$testDir = Join-Path $pluginDir "test"
if (Test-Path -LiteralPath $testDir) {
  Push-Location -LiteralPath $pluginDir
  try {
    & $nodeCli --test
    $testExit = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($testExit -ne 0) {
    throw ("测试失败（exit " + $testExit + "），后续步骤未执行。")
  }
} else {
  Write-Host "  没有 test/ 目录，跳过"
}

Write-Host "[3/4] desktop profile 链接"
$profileLink = Join-Path $env:USERPROFILE ".dsh\profiles\desktop\node_modules\dsh-style-memory"
if (Test-Path -LiteralPath $profileLink) {
  Write-Host "  desktop profile 链接正常"
} else {
  Write-Warning "  desktop profile 里没有 dsh-style-memory，先运行 install.ps1"
}

Write-Host "[4/4] 完成"
Write-Host ""
Write-Host ("重启 DeepSeek Harness 以加载版本 " + $version + "。")
Write-Host "重启后插件管理页显示新版本；新会话才会注入新的风格卡，旧会话不会热更新。"
