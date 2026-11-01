# dsh-style-memory uninstaller: removes this package from the DSH desktop profile.
# 加 -PurgeData 会同时删除 %USERPROFILE%\.dsh\style-memory 下的全部本地数据。
param([switch]$PurgeData)

$ErrorActionPreference = "Stop"

$bundledCli = Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$dshCli = $null
if (Test-Path -LiteralPath $bundledCli) {
  $dshCli = $bundledCli
} else {
  $dshCommand = Get-Command dsh -ErrorAction SilentlyContinue
  if ($dshCommand) { $dshCli = $dshCommand.Source }
}
if (-not $dshCli) {
  throw "未找到 dsh CLI。手动执行：dsh plugin --profile desktop remove dsh-style-memory"
}

Write-Host ("使用 CLI：" + $dshCli)
& $dshCli plugin --profile desktop remove dsh-style-memory
if ($LASTEXITCODE -ne 0) {
  throw ("卸载失败（exit " + $LASTEXITCODE + "）")
}
Write-Host "已从 desktop profile 移除，重启 DeepSeek Harness 后不再加载。"

$dataDir = Join-Path $env:USERPROFILE ".dsh\style-memory"
if ($PurgeData) {
  if (Test-Path -LiteralPath $dataDir) {
    $leafName = Split-Path -Path $dataDir -Leaf
    if ($leafName -ne "style-memory") {
      throw ("数据目录名与预期不符，已中止删除：" + $dataDir)
    }
    Remove-Item -LiteralPath $dataDir -Recurse -Force
    Write-Host ("已删除数据目录：" + $dataDir)
  } else {
    Write-Host ("数据目录不存在，无需删除：" + $dataDir)
  }
} else {
  Write-Host ("保留数据目录：" + $dataDir)
  Write-Host "要连数据一起删，重新执行并加 -PurgeData。"
}
