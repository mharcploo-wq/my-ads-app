# เปิดแอป Ads Control: ถ้าเซิร์ฟเวอร์หน้าเว็บยังไม่รัน → สั่งรันแบบซ่อนหน้าต่าง แล้วเปิดเป็นหน้าต่างแอป
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$dash = Join-Path $root 'dashboard'
$url  = 'http://localhost:3000'
$log  = Join-Path $env:TEMP 'ads-control.log'

function Test-Up {
  try { (Invoke-WebRequest "$url/api/metrics" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false }
}

if (-not (Test-Up)) {
  Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -WorkingDirectory $dash `
    -ArgumentList '/c', "npm run dev > `"$log`" 2>&1"
  for ($i = 0; $i -lt 90 -and -not (Test-Up); $i++) { Start-Sleep -Seconds 1 }
  if (-not (Test-Up)) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("เปิด Ads Control ไม่สำเร็จ`nดูรายละเอียดได้ที่ $log", 'Ads Control') | Out-Null
    exit 1
  }
}

$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($browser) { Start-Process $browser -ArgumentList "--app=$url", '--window-size=1360,900' }
else { Start-Process $url }
