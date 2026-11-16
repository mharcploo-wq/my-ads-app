# เปิดแอป Ads Control: ถ้าเซิร์ฟเวอร์หน้าเว็บยังไม่รัน → สั่งรันแบบซ่อนหน้าต่าง แล้วเปิดเป็นหน้าต่างแอป
# พอร์ต 3100 = ของ Ads Control (3000 ชนกับแอปอื่นในเครื่อง) — ต้องตรงกับ dashboard/package.json
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$dash = Join-Path $root 'dashboard'
$port = 3100
$url  = "http://localhost:$port"
$log  = Join-Path $env:TEMP 'ads-control.log'

# ต้องเป็น Ads Control จริง: /api/metrics ตอบ 200 ตรง ๆ (ไม่ตาม redirect) และมีรายการแคมเปญ
# แอปอื่นที่ redirect ไปหน้า login ก็ได้ 200 ถ้าตาม redirect → เคยเปิดผิดแอป
function Test-Up {
  try {
    $r = Invoke-WebRequest "$url/api/metrics" -UseBasicParsing -TimeoutSec 3 -MaximumRedirection 0 -ErrorAction Stop
    $r.StatusCode -eq 200 -and $null -ne ($r.Content | ConvertFrom-Json).campaigns
  } catch { $false }
}

function Show-Msg($text) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($text, 'Ads Control') | Out-Null
}

if (-not (Test-Up)) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen) {
    Show-Msg "พอร์ต $port ถูกแอปอื่นใช้อยู่ — ปิดแอปนั้นก่อนแล้วเปิด Ads Control ใหม่"
    exit 1
  }
  Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -WorkingDirectory $dash `
    -ArgumentList '/c', "npm run dev > `"$log`" 2>&1"
  for ($i = 0; $i -lt 90 -and -not (Test-Up); $i++) { Start-Sleep -Seconds 1 }
  if (-not (Test-Up)) {
    Show-Msg "เปิด Ads Control ไม่สำเร็จ`nดูรายละเอียดได้ที่ $log"
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
