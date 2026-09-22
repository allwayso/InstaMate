<#
  dev-browser.ps1 — 前端/Browser 进程管家（Windows）

  为什么要用它：headless Chrome 是「常驻」进程（开了不会自己退），而且一个实例 = 7~8 个进程
  （主进程 + renderer + gpu + utility×N + crashpad）。用 pkill 按命令行匹配只能杀到主进程，
  子进程会变孤儿继续跑 rAF 循环，把 CPU 吃满。

  规则：**每次重开之前先 down，重开之后 status 确认，全程用 cpu 看占用。**

  用法:
    powershell -NoProfile -File tools/dev-browser.ps1 status
    powershell -NoProfile -File tools/dev-browser.ps1 down
    powershell -NoProfile -File tools/dev-browser.ps1 up -Port 9222 -Url http://localhost:3000/
    powershell -NoProfile -File tools/dev-browser.ps1 cpu

  安全承诺：只处理命令行里带 `--headless` 或本项目路径的 chrome.exe，
  绝不会碰你自己正常用的 Chrome / Edge。
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'up', 'down', 'cpu')]
  [string]$Action = 'status',

  [int]$Port = 9222,
  [string]$Url = 'http://localhost:3000/',
  [int]$CpuWarn = 70,

  # GL 后端：hardware = 用真显卡（AMD Radeon 780M）；swiftshader = 软件光栅化
  # 实测：swiftshader 会把 16 逻辑核跑到 100%，hardware 低得多——默认用 hardware
  [ValidateSet('hardware', 'swiftshader')]
  [string]$Gl = 'hardware'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ProfileDir = Join-Path $RepoRoot '.g0\chrome-profile'
$PidFile = Join-Path $RepoRoot '.g0\browser.pid'
$Chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

# ---------- 识别「我起的」进程 ----------
function Get-OurChrome {
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object {
      $_.CommandLine -and (
        $_.CommandLine -match '--headless' -or
        $_.CommandLine -like "*$RepoRoot*"
      )
    }
}

function Get-DevServer {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$RepoRoot*" }
}

function Show-Cpu {
  # 取 3 次采样的峰值：瞬时低谷会读成 0%，容易让人误以为没事
  $samples = @()
  1..3 | ForEach-Object {
    $s = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
    $samples += [int]$s.PercentProcessorTime
    Start-Sleep -Milliseconds 400
  }
  $load = ($samples | Measure-Object -Maximum).Maximum
  $cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
  $top = Get-Process | Sort-Object -Property CPU -Descending |
    Select-Object -First 5 |
    ForEach-Object { "      {0,-24} PID {1,-7} 累计 {2,9:N1}s" -f $_.Name, $_.Id, $_.CPU }
  Write-Host ("  当前 CPU 峰值占用: {0}%  (共 {1} 逻辑核，采样 {2}%)" -f $load, $cores, ($samples -join '/')) `
    -ForegroundColor $(if ($load -ge $CpuWarn) { 'Red' } elseif ($load -ge 40) { 'Yellow' } else { 'Green' })
  Write-Host '  CPU 累计耗时前 5（找长期吃 CPU 的）:'
  $top | ForEach-Object { Write-Host $_ }
  return $load
}

function Show-Status {
  $chrome = @(Get-OurChrome)
  $node = @(Get-DevServer)

  Write-Host '=== 我起的进程 ===' -ForegroundColor Cyan
  Write-Host ("  headless chrome : {0} 个进程" -f $chrome.Count) -ForegroundColor $(if ($chrome.Count -gt 0) { 'Yellow' } else { 'Green' })
  if ($chrome.Count -gt 0) {
    $chrome | Group-Object ParentProcessId | ForEach-Object {
      Write-Host ("      进程树 parent {0} → {1} 个" -f $_.Name, $_.Count)
    }
  }
  Write-Host ("  本项目 node     : {0} 个进程" -f $node.Count) -ForegroundColor $(if ($node.Count -gt 0) { 'Yellow' } else { 'Green' })
  $node | ForEach-Object { Write-Host ("      PID {0}" -f $_.ProcessId) }

  if (Test-Path $PidFile) {
    $saved = Get-Content $PidFile -ErrorAction SilentlyContinue
    $alive = if ($saved) { Get-Process -Id $saved -ErrorAction SilentlyContinue } else { $null }
    Write-Host ("  已记录 browser PID: {0} ({1})" -f $saved, $(if ($alive) { '存活' } else { '已退出' }))
  }

  Write-Host ''
  Write-Host '=== CPU ===' -ForegroundColor Cyan
  $null = Show-Cpu

  Write-Host ''
  Write-Host '=== 端口 ===' -ForegroundColor Cyan
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3000/' -TimeoutSec 3 -UseBasicParsing
    Write-Host ("  localhost:3000 → HTTP {0}" -f $r.StatusCode) -ForegroundColor Green
  } catch {
    Write-Host '  localhost:3000 → 未响应' -ForegroundColor Gray
  }
}

function Stop-OurChrome {
  $chrome = @(Get-OurChrome)
  if ($chrome.Count -eq 0) {
    Write-Host '  headless chrome: 无需清理（0 个）' -ForegroundColor Green
    return
  }
  # 只对「进程树的根」发 taskkill /T，/T 会连带整棵子树，避免孤儿
  # 用字符串比较，避开 UInt32/Int32 混比的坑；并显式包裹成数组，否则单元素时 .Count 为空
  $allIds = @($chrome.ProcessId | ForEach-Object { "$_" })
  $roots = @($chrome | Where-Object { $allIds -notcontains "$($_.ParentProcessId)" })
  Write-Host ("  headless chrome: 共 {0} 个进程，从 {1} 个根节点用 /T 整树杀" -f $chrome.Count, $roots.Count) -ForegroundColor Yellow
  foreach ($p in $roots) {
    & taskkill /PID $p.ProcessId /T /F 2>&1 | Out-Null
  }
  Start-Sleep -Milliseconds 800
  # 兜底：清掉任何残留
  $left = @(Get-OurChrome)
  foreach ($p in $left) { & taskkill /PID $p.ProcessId /T /F 2>&1 | Out-Null }
  Start-Sleep -Milliseconds 500
  $final = @(Get-OurChrome).Count
  Write-Host ("  清理后剩余: {0} 个 {1}" -f $final, $(if ($final -eq 0) { '✅' } else { '⚠️' })) -ForegroundColor $(if ($final -eq 0) { 'Green' } else { 'Red' })
  if (Test-Path $ProfileDir) {
    Remove-Item -Recurse -Force $ProfileDir -ErrorAction SilentlyContinue
  }
  Remove-Item -Force $PidFile -ErrorAction SilentlyContinue
}

function Stop-DevServer {
  $node = @(Get-DevServer)
  if ($node.Count -eq 0) {
    Write-Host '  本项目 node: 无需清理（0 个）' -ForegroundColor Green
    return
  }
  Write-Host ("  本项目 node: 清理 {0} 个进程" -f $node.Count) -ForegroundColor Yellow
  foreach ($p in $node) { & taskkill /PID $p.ProcessId /T /F 2>&1 | Out-Null }
  Start-Sleep -Milliseconds 800
  $final = @(Get-DevServer).Count
  Write-Host ("  清理后剩余: {0} 个 {1}" -f $final, $(if ($final -eq 0) { '✅' } else { '⚠️' })) -ForegroundColor $(if ($final -eq 0) { 'Green' } else { 'Red' })
}

switch ($Action) {
  'status' { Show-Status }
  'cpu' { $null = Show-Cpu }
  'down' {
    Write-Host '=== 清理 ===' -ForegroundColor Cyan
    Stop-OurChrome
    Write-Host ''
    $null = Show-Cpu
  }
  'up' {
    Write-Host '=== 开前先清（规矩：绝不叠着跑） ===' -ForegroundColor Cyan
    Stop-OurChrome
    $load = Show-Cpu
    if ($load -ge $CpuWarn) {
      Write-Host ("  ⚠️ CPU 已 {0}%，不建议现在开浏览器。先查是谁在占。" -f $load) -ForegroundColor Red
      exit 1
    }
    if (-not (Test-Path $Chrome)) { Write-Host "找不到 Chrome: $Chrome" -ForegroundColor Red; exit 1 }
    if (-not (Test-Path $ProfileDir)) { New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null }

    Write-Host ''
    Write-Host ("=== 启动（仅 1 个实例，GL={0}） ===" -f $Gl) -ForegroundColor Cyan

    $glArgs = if ($Gl -eq 'swiftshader') {
      @('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader')
    } else {
      @('--use-angle=default')
    }

    $args = @(
      '--headless=new', '--no-sandbox',
      '--disable-http-cache',
      "--remote-debugging-port=$Port",
      '--window-size=1400,900',
      "--user-data-dir=$ProfileDir"
    ) + $glArgs + @($Url)
    $proc = Start-Process -FilePath $Chrome -ArgumentList $args -PassThru -WindowStyle Hidden
    $proc.Id | Set-Content $PidFile
    Start-Sleep -Seconds 6
    $count = @(Get-OurChrome).Count
    Write-Host ("  已启动 browser PID {0}（该实例当前共 {1} 个进程）" -f $proc.Id, $count) -ForegroundColor Green
    Write-Host ("  CDP: http://127.0.0.1:{0}" -f $Port)
    Write-Host ''
    $null = Show-Cpu
    Write-Host ''
    Write-Host '  ⚠️ 用完立刻执行: dev-browser.ps1 down' -ForegroundColor Yellow
  }
}
