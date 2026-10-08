# Installs release-dist/*-setup.exe silently the way a user (or the in-app updater) does, checks what a Windows desktop
# needs, launches the installed app through the packaged smoke test, then uninstalls and checks it is all gone. CI (#317).
#   pwsh scripts/test-windows-install.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
function Fail($message) { Write-Host "INSTALL CHECK FAIL: $message"; exit 1 }
function Wait-Until($what, [scriptblock]$condition, $seconds = 120) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while (-not (& $condition)) { if ((Get-Date) -gt $deadline) { Fail "timed out waiting for $what" }; Start-Sleep -Milliseconds 500 }
}

$setup = Get-ChildItem release-dist\*-setup.exe | Select-Object -First 1
if (-not $setup) { Fail 'no setup.exe in release-dist' }
$dir = Join-Path $env:LOCALAPPDATA 'Programs\muster-agent'
$exe = Join-Path $dir 'muster-agent.exe'
$uninstaller = Join-Path $dir 'Uninstall Muster Agent.exe'
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Muster Agent.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Muster Agent.lnk'
$protocol = 'HKCU:\Software\Classes\muster'

Write-Host "installing $($setup.Name) silently for this user"
$started = Get-Date
$install = Start-Process $setup.FullName -ArgumentList '/S' -PassThru -Wait
if ($install.ExitCode -ne 0) { Fail "installer exited $($install.ExitCode)" }
Write-Host ("installed in {0:N1}s" -f ((Get-Date) - $started).TotalSeconds)

$entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like 'Muster Agent*' }
if (-not $entry) { Fail 'no Apps & features (uninstall) entry under HKCU' }
$location = (Get-ItemProperty $entry.PSPath).InstallLocation
Write-Host "install location: $location"
if ($location -and ((Resolve-Path $location).Path.TrimEnd('\') -ne $dir)) { Fail "installed to $location, expected $dir (per user)" }
# Per user, no admin: everything under %LOCALAPPDATA% and HKCU.
if (-not (Test-Path $exe)) { Fail "$exe missing" }
if (-not (Test-Path $uninstaller)) { Fail 'uninstaller missing' }
if (-not (Test-Path (Join-Path $dir 'resources\app.asar'))) { Fail 'resources\app.asar missing (asar: true)' }
if (Test-Path (Join-Path $dir 'resources\app')) { Fail 'resources\app still holds loose files' }
foreach ($unpacked in @('node_modules\node-pty\package.json', 'dist\main\browser-mcp.cjs', 'dist\runtime\resources\codex-profile.cjs')) {
  if (-not (Test-Path (Join-Path $dir "resources\app.asar.unpacked\$unpacked"))) { Fail "app.asar.unpacked lacks $unpacked" }
}
$files = (Get-ChildItem $dir -Recurse -File).Count
Write-Host "installed files: $files"
if ($files -gt 1500) { Fail "$files files installed; app.asar should keep this to a few hundred" }
if (-not (Test-Path $startMenu)) { Fail "Start-menu shortcut missing: $startMenu" }
if (-not (Test-Path $desktop)) { Fail "desktop shortcut missing: $desktop" }
$shell = New-Object -ComObject WScript.Shell
if ($shell.CreateShortcut($startMenu).TargetPath -ne $exe) { Fail 'Start-menu shortcut points elsewhere' }
# muster:// is registered by the installer itself (resources/windows/installer.nsh), before the app ever runs.
if (-not (Test-Path $protocol)) { Fail 'muster:// is not registered after install' }
if ((Get-ItemProperty $protocol).'URL Protocol' -ne '') { Fail 'muster key is not a URL protocol' }
$command = (Get-ItemProperty "$protocol\shell\open\command").'(default)'
if ($command -ne "`"$exe`" `"%1`"") { Fail "muster:// opens '$command'" }
Write-Host "muster:// -> $command"

# What the in-app updater runs (minus --force-run, which would start the app): the installer over an existing install.
# The old version's uninstaller runs with --updated, so muster:// and the shortcuts must survive it.
Write-Host 'updating in place: setup.exe --updated /S'
$update = Start-Process $setup.FullName -ArgumentList '--updated', '/S' -PassThru -Wait
if ($update.ExitCode -ne 0) { Fail "the update install exited $($update.ExitCode)" }
if (-not (Test-Path $exe)) { Fail 'the app is gone after an in-place update' }
if (-not (Test-Path $protocol)) { Fail 'an in-place update unregistered muster://' }
if (-not (Test-Path $startMenu)) { Fail 'an in-place update removed the Start-menu shortcut' }

Write-Host 'launching the installed app (headless smoke test)'
$env:SMOKE_EXPECT_UPDATES = '1'
$env:SMOKE_EXPECT_UPDATE_METHOD = 'nsis'
$env:SMOKE_PORT = '9481'
node scripts/smoke-packaged.mjs $exe
if ($LASTEXITCODE -ne 0) { Fail 'the installed app failed its smoke test' }
Wait-Until 'the app to exit' { -not (Get-Process -Name 'muster-agent' -ErrorAction SilentlyContinue) } 30
# The app re-registers muster:// on launch with the same command; it must still be ours.
if ((Get-ItemProperty "$protocol\shell\open\command").'(default)' -ne $command) { Fail 'the app changed the muster:// command' }

Write-Host 'uninstalling silently'
Start-Process $uninstaller -ArgumentList '/S' -Wait
# The uninstaller re-runs itself from %TEMP%; wait for it to finish removing the app.
Wait-Until 'the app folder to be removed' { -not (Test-Path $exe) }
Wait-Until 'the shortcuts to be removed' { -not (Test-Path $startMenu) -and -not (Test-Path $desktop) } 30
Wait-Until 'muster:// to be unregistered' { -not (Test-Path $protocol) } 30
$left = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like 'Muster Agent*' }
if ($left) { Fail 'the uninstall entry is still there' }
Write-Host 'INSTALL CHECK OK'
