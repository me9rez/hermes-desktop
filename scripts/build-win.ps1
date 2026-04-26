[CmdletBinding()]
<#
.SYNOPSIS
  Hermes Desktop Windows 构建脚本（PowerShell）。

.DESCRIPTION
  统一执行 Windows 构建流程：
  1) 前置检查（node/pnpm/uv/git、Node 版本、环境变量）
  2) 可选安装依赖
  3) 构建 Electron 主进程/预加载
  4) 打包 runtime 资源
  5) 产出 Windows 安装包

  默认使用阿里云 PyPI 镜像：
  http://mirrors.aliyun.com/pypi/simple

.EXAMPLE
  # 基础构建（默认使用阿里云 PyPI）
  pwsh -File .\scripts\build-win.ps1

.EXAMPLE
  # 首次机器建议：先安装依赖再构建
  pwsh -File .\scripts\build-win.ps1 -InstallDeps

.EXAMPLE
  # 强制重建 venv
  pwsh -File .\scripts\build-win.ps1 -RebuildVenv

.EXAMPLE
  # 指定其他 PyPI 镜像
  pwsh -File .\scripts\build-win.ps1 -PypiIndexUrl "https://pypi.org/simple"
#>
param(
  # 是否先安装依赖（默认跳过，加速本地反复打包）
  [switch]$InstallDeps,
  # 是否强制重建 venv（传递给 package-resources.js 的 --rebuild-venv）
  [switch]$RebuildVenv,
  # 是否跳过 runtime 资源打包
  [switch]$SkipResources,
  # 是否跳过 Electron 主进程/预加载构建
  [switch]$SkipBuild,
  # PyPI 源（默认阿里云镜像）
  [string]$PypiIndexUrl = "http://mirrors.aliyun.com/pypi/simple"
)

# 严格模式：变量未定义等问题直接报错，避免脚本“带病执行”
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# 仓库根目录（scripts 的上一级）
$RepoRoot = Split-Path -Parent $PSScriptRoot
# Windows 构建产物输出目录
$OutputDir = Join-Path $RepoRoot "out\win32-x64"

# 打印阶段标题，便于 CI / 本地阅读日志
function Write-Section {
  param([string]$Message)
  Write-Host ""
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

# 统一失败退出：输出错误并返回非 0
function Fail {
  param([string]$Message)
  Write-Error $Message
  exit 1
}

# 校验命令是否存在（node/pnpm/uv/git）
function Get-CommandPath {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    Fail "Missing required command: $Name"
  }
  return $cmd.Source
}

# 执行单个步骤命令，并在失败时立即中断
function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $joined = if ($Arguments.Count -gt 0) { $Arguments -join " " } else { "" }
  Write-Host "-> $Command $joined"
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "Command failed (exit code $LASTEXITCODE): $Command $joined"
  }
}

# 校验 Node.js 最低版本（与 package.json engines 对齐）
function Test-MinNodeVersion {
  param([string]$MinVersion)

  $nodeVersionRaw = (& node --version).Trim()
  if (-not $nodeVersionRaw) {
    Fail "Unable to read Node.js version."
  }
  $nodeVersionClean = $nodeVersionRaw.TrimStart("v")
  try {
    $current = [Version]$nodeVersionClean
    $minimum = [Version]$MinVersion
  } catch {
    Fail "Failed to parse Node.js version: '$nodeVersionRaw'"
  }

  if ($current -lt $minimum) {
    Fail "Node.js $MinVersion+ required, current: $nodeVersionRaw"
  }
}

# 从 Process/User/Machine 三级读取环境变量并校验目录存在
function Resolve-RequiredDirectoryFromEnv {
  param([string]$EnvName)

  $value = [Environment]::GetEnvironmentVariable($EnvName, "Process")
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = [Environment]::GetEnvironmentVariable($EnvName, "User")
  }
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = [Environment]::GetEnvironmentVariable($EnvName, "Machine")
  }
  if ([string]::IsNullOrWhiteSpace($value)) {
    Fail "Environment variable '$EnvName' is required."
  }

  $resolved = Resolve-Path -LiteralPath $value -ErrorAction SilentlyContinue
  if (-not $resolved) {
    Fail "Path from '$EnvName' does not exist: $value"
  }
  if (-not (Test-Path -LiteralPath $resolved.Path -PathType Container)) {
    Fail "Path from '$EnvName' is not a directory: $($resolved.Path)"
  }
  return $resolved.Path
}

Push-Location $RepoRoot
try {
  # 1) 前置检查：工具链 + Node 版本 + 必需环境变量
  Write-Section "Preflight Checks"
  Get-CommandPath -Name "node" | Out-Null
  Get-CommandPath -Name "pnpm" | Out-Null
  Get-CommandPath -Name "uv" | Out-Null
  Get-CommandPath -Name "git" | Out-Null
  Test-MinNodeVersion -MinVersion "24.15.0"

  $agentDir = Resolve-RequiredDirectoryFromEnv -EnvName "HERMES_AGENT_DIR"
  $webuiDir = Resolve-RequiredDirectoryFromEnv -EnvName "HERMES_WEBUI_DIR"

  Write-Host "HERMES_AGENT_DIR = $agentDir"
  Write-Host "HERMES_WEBUI_DIR  = $webuiDir"
  Write-Host "PYPI_INDEX_URL    = $PypiIndexUrl"

  # uv 优先读取 UV_INDEX_URL；同时设置 PIP_INDEX_URL 便于兼容
  $env:UV_INDEX_URL = $PypiIndexUrl
  $env:PIP_INDEX_URL = $PypiIndexUrl

  # 2) 可选安装依赖（默认跳过）
  if ($InstallDeps) {
    Write-Section "Install Dependencies"
    Invoke-Step -Command "pnpm" -Arguments @("install")
  } else {
    Write-Host ""
    Write-Host "Skipping dependency install (use -InstallDeps to enable)."
  }

  # 3) 构建 Electron 主进程/预加载产物
  if (-not $SkipBuild) {
    Write-Section "Build Main/Preload"
    Invoke-Step -Command "pnpm" -Arguments @("run", "build")
  } else {
    Write-Host ""
    Write-Host "Skipping TypeScript build (use without -SkipBuild to enable)."
  }

  # 4) 打包 Python/venv/runtime/tools/webui 等资源
  if (-not $SkipResources) {
    Write-Section "Package Runtime Resources"
    $resourceArgs = @("run", "package:resources", "--", "--platform", "win32", "--arch", "x64")
    if ($RebuildVenv) {
      $resourceArgs += "--rebuild-venv"
    }
    Invoke-Step -Command "pnpm" -Arguments $resourceArgs
  } else {
    Write-Host ""
    Write-Host "Skipping resources packaging (use without -SkipResources to enable)."
  }

  # 5) 生成 Windows 安装包（NSIS）
  Write-Section "Build Windows Installer"
  Invoke-Step -Command "pnpm" -Arguments @(
    "exec",
    "electron-builder",
    "--win",
    "--x64",
    "--config.directories.output=out/win32-x64",
    "--publish",
    "never"
  )

  # 6) 输出结果路径
  Write-Section "Done"
  Write-Host "Installer artifacts: $OutputDir" -ForegroundColor Green
}
finally {
  Pop-Location
}
