[CmdletBinding()]
param(
  [string]$SourcePng = "D:\Code\Github Repo\hermes-desktop\assets\logo.png",
  [string]$AssetsDir = "D:\Code\Github Repo\hermes-desktop\assets",
  [string]$MagickDir = "C:\DevTools\ImageMagick-7.1.2-21-portable-Q16-HDRI-x64"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Fail {
  param([string]$Message)
  Write-Error $Message
  exit 1
}

function Invoke-Magick {
  param(
    [Parameter(Mandatory = $true)][string]$MagickExe,
    [Parameter(Mandatory = $true)][string[]]$CommandArgs
  )

  $joined = $CommandArgs -join " "
  Write-Host "-> magick $joined"
  & $MagickExe @CommandArgs
  if ($LASTEXITCODE -ne 0) {
    Fail "ImageMagick command failed (exit code $LASTEXITCODE): magick $joined"
  }
}

function Ensure-PathExists {
  param(
    [Parameter(Mandatory = $true)][string]$PathValue,
    [Parameter(Mandatory = $true)][string]$Label,
    [switch]$Directory
  )

  if (-not (Test-Path -LiteralPath $PathValue)) {
    Fail "$Label not found: $PathValue"
  }
  if ($Directory -and -not (Test-Path -LiteralPath $PathValue -PathType Container)) {
    Fail "$Label must be a directory: $PathValue"
  }
}

function New-SquarePng {
  param(
    [Parameter(Mandatory = $true)][string]$MagickExe,
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][int]$Size,
    [Parameter(Mandatory = $true)][string]$TargetPath
  )

  Invoke-Magick -MagickExe $MagickExe -CommandArgs @(
    $SourcePath,
    "-resize", "${Size}x${Size}",
    "-background", "none",
    "-gravity", "center",
    "-extent", "${Size}x${Size}",
    $TargetPath
  )
}

$MagickExe = Join-Path $MagickDir "magick.exe"
Ensure-PathExists -PathValue $MagickExe -Label "magick.exe"
Ensure-PathExists -PathValue $SourcePng -Label "Source logo.png"
Ensure-PathExists -PathValue $AssetsDir -Label "Assets directory" -Directory

$resolvedSource = (Resolve-Path -LiteralPath $SourcePng).Path
$resolvedAssets = (Resolve-Path -LiteralPath $AssetsDir).Path

$iconPng = Join-Path $resolvedAssets "icon.png"
$iconIco = Join-Path $resolvedAssets "icon.ico"
$iconIcns = Join-Path $resolvedAssets "icon.icns"
$trayPng = Join-Path $resolvedAssets "tray-icon.png"
$tray2xPng = Join-Path $resolvedAssets "tray-icon@2x.png"
$trayTemplatePng = Join-Path $resolvedAssets "tray-iconTemplate.png"
$trayTemplate2xPng = Join-Path $resolvedAssets "tray-iconTemplate@2x.png"
$critterPng = Join-Path $resolvedAssets "critter-128.png"

$tmpDir = Join-Path $resolvedAssets ".iconset-tmp"
if (Test-Path -LiteralPath $tmpDir) {
  Remove-Item -LiteralPath $tmpDir -Recurse -Force
}
New-Item -ItemType Directory -Path $tmpDir | Out-Null

try {
  Write-Host ""
  Write-Host "== Generate PNG assets ==" -ForegroundColor Cyan
  New-SquarePng -MagickExe $MagickExe -SourcePath $resolvedSource -Size 1024 -TargetPath $iconPng
  New-SquarePng -MagickExe $MagickExe -SourcePath $resolvedSource -Size 128 -TargetPath $critterPng
  New-SquarePng -MagickExe $MagickExe -SourcePath $resolvedSource -Size 16 -TargetPath $trayPng
  New-SquarePng -MagickExe $MagickExe -SourcePath $resolvedSource -Size 32 -TargetPath $tray2xPng
  New-SquarePng -MagickExe $MagickExe -SourcePath $resolvedSource -Size 16 -TargetPath $trayTemplatePng
  New-SquarePng -MagickExe $MagickExe -SourcePath $resolvedSource -Size 32 -TargetPath $trayTemplate2xPng

  Write-Host ""
  Write-Host "== Generate ICO ==" -ForegroundColor Cyan
  $icoSizes = @(16, 24, 32, 48, 64, 128, 256)
  $icoFrames = @()
  foreach ($s in $icoSizes) {
    $frame = Join-Path $tmpDir ("ico-{0}.png" -f $s)
    New-SquarePng -MagickExe $MagickExe -SourcePath $resolvedSource -Size $s -TargetPath $frame
    $icoFrames += $frame
  }
  Invoke-Magick -MagickExe $MagickExe -CommandArgs @($icoFrames + @($iconIco))

  Write-Host ""
  Write-Host "== Generate ICNS ==" -ForegroundColor Cyan
  $icnsSizes = @(16, 32, 64, 128, 256, 512, 1024)
  $icnsFrames = @()
  foreach ($s in $icnsSizes) {
    $frame = Join-Path $tmpDir ("icns-{0}.png" -f $s)
    New-SquarePng -MagickExe $MagickExe -SourcePath $resolvedSource -Size $s -TargetPath $frame
    $icnsFrames += $frame
  }
  Invoke-Magick -MagickExe $MagickExe -CommandArgs @($icnsFrames + @($iconIcns))

  Write-Host ""
  Write-Host "== Done ==" -ForegroundColor Green
  Write-Host $iconPng
  Write-Host $iconIco
  Write-Host $iconIcns
  Write-Host $trayPng
  Write-Host $tray2xPng
  Write-Host $trayTemplatePng
  Write-Host $trayTemplate2xPng
  Write-Host $critterPng
}
finally {
  if (Test-Path -LiteralPath $tmpDir) {
    Remove-Item -LiteralPath $tmpDir -Recurse -Force
  }
}
