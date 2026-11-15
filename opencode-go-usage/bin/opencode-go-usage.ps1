$ErrorActionPreference = 'Stop'

$mode = $args[0]

# JSON goes straight to stdout as UTF-8. The previous temp-file handoff could
# collide when the plugin ran usage + sessions at the same time (%RANDOM% is
# seeded per cmd.exe), which surfaced as truncated/garbled JSON.
$writer = New-Object IO.StreamWriter(
  [Console]::OpenStandardOutput(),
  (New-Object Text.UTF8Encoding($false))
)
$writer.AutoFlush = $true

function Write-Payload([string]$text) {
  $writer.Write($text)
  $writer.Flush()
}

function Write-Fail([string]$message) {
  $json = @{ error = @{ message = $message } } | ConvertTo-Json -Compress -Depth 5
  Write-Payload $json
  exit 1
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  if ($mode -eq 'usage') {
    if (-not $env:OPENCODE_GO_KEY) { Write-Fail 'missing API key' }
    $headers = @{
      Authorization = 'Bearer ' + $env:OPENCODE_GO_KEY
      Accept = 'application/json'
    }
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'https://opencode.ai/zen/go/v1/usage' -Headers $headers -TimeoutSec 20
  } elseif ($mode -eq 'sessions') {
    if (-not $env:OPENCODE_URL) { Write-Fail 'opencode service is not running' }
    $pair = 'opencode:' + $env:OPENCODE_PASS
    $basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
    $headers = @{
      Authorization = 'Basic ' + $basic
      Accept = 'application/json'
    }
    $response = Invoke-WebRequest -UseBasicParsing -Uri ($env:OPENCODE_URL + '/api/session') -Headers $headers -TimeoutSec 20
  } else {
    Write-Fail 'unknown command'
  }

  Write-Payload $response.Content
  exit 0
} catch {
  $body = $null
  try {
    $response = $_.Exception.Response
    if ($response) {
      $reader = New-Object IO.StreamReader($response.GetResponseStream())
      $body = $reader.ReadToEnd()
      $reader.Dispose()
    }
  } catch {
    $body = $null
  }
  if (-not $body) {
    $message = $_.Exception.Message
    $body = @{ error = @{ message = $message } } | ConvertTo-Json -Compress -Depth 5
  }
  Write-Payload $body
  exit 1
}
