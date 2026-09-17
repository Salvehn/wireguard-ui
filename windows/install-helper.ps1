param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Key,
  [Parameter(Mandatory=$true)][string]$Token,
  [Parameter(Mandatory=$true)][string]$UserSid
)
$ErrorActionPreference = 'Stop'
if ($Key -notmatch '^[a-f0-9]{16}$' -or $Token -notmatch '^[a-f0-9]{64}$' -or $UserSid -notmatch '^S-1-(?:\d+-){2,14}\d+$') { throw 'Invalid helper identity' }
$Source = [IO.Path]::GetFullPath($Source)
foreach ($name in @('windows-server.cjs','bin\node.exe','bin\helper-host.exe','bin\sing-box.exe','bin\wireguard\wireguard.exe','bin\wireguard\wg.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $Source $name) -PathType Leaf)) { throw "Missing helper file: $name" }
}
$service = "WireGuardDesktopHelper-$Key"
$root = Join-Path $env:ProgramData 'WireGuardDesktop'
$destination = Join-Path $root "Helper-$Key"
$stage = "$destination.install"
& sc.exe stop $service 2>$null | Out-Null
for ($i=0; $i -lt 40; $i++) {
  $state = (& sc.exe query $service 2>$null | Out-String)
  if ($state -notmatch 'STATE\s*:\s*\d+\s+STOP_PENDING') { break }
  Start-Sleep -Milliseconds 250
}
& sc.exe delete $service 2>$null | Out-Null
for ($i=0; $i -lt 40; $i++) {
  & sc.exe query $service 2>$null | Out-Null
  if ($LASTEXITCODE -eq 1060) { break }
  Start-Sleep -Milliseconds 250
}
if ($LASTEXITCODE -ne 1060) { throw 'Previous helper service is still being removed' }
if (Test-Path -LiteralPath (Join-Path $destination 'tunnels') -PathType Container) {
  Get-ChildItem -LiteralPath (Join-Path $destination 'tunnels') -Filter 'wg??????????.conf' -File -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.BaseName -match '^wg[a-f0-9]{10}$') {
      $tunnelService = 'WireGuardTunnel$' + $_.BaseName
      & sc.exe stop $tunnelService 2>$null | Out-Null
      for ($i=0; $i -lt 40; $i++) {
        $state = (& sc.exe query $tunnelService 2>$null | Out-String)
        if ($state -notmatch 'STATE\s*:\s*\d+\s+STOP_PENDING') { break }
        Start-Sleep -Milliseconds 250
      }
      & sc.exe delete $tunnelService 2>$null | Out-Null
    }
  }
}
Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item -Path (Join-Path $Source '*') -Destination $stage -Recurse -Force
Get-ChildItem -LiteralPath $stage -Recurse -Force | ForEach-Object {
  if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Helper package contains a reparse point' }
}
Set-Content -LiteralPath (Join-Path $stage 'token') -Value $Token -NoNewline -Encoding Ascii
New-Item -ItemType Directory -Path $root -Force | Out-Null
Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
Move-Item -LiteralPath $stage -Destination $destination
& icacls.exe $destination '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
$hostPath = Join-Path $destination 'bin\helper-host.exe'
$quotedHost = '"' + $hostPath + '"'
& sc.exe create $service 'binPath=' $quotedHost 'start=' 'auto' 'obj=' 'LocalSystem' 'DisplayName=' "WireGuard Desktop Helper ($Key)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not create WireGuard Desktop helper service' }
& sc.exe description $service 'Privileged network backend for WireGuard Desktop' | Out-Null
& sc.exe failure $service 'reset=' '86400' 'actions=' 'restart/3000/restart/10000/none/0' | Out-Null
& sc.exe start $service | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not start WireGuard Desktop helper service' }
