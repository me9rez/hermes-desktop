#!/usr/bin/env node
/**
 * package-resources.js — Hermes Desktop 资源打包脚本
 *
 * 下载并准备所有运行时依赖：
 *   1. Standalone Python 3.13.13 (python-build-standalone)
 *   2. 创建 venv 并安装 hermes-agent + hermes-webui 依赖
 *   3. Node.js 24.15.0 (用于 browser tools + webui server)
 *   4. ripgrep 二进制
 *   5. 构建并复制 hermes-web-ui 产物（server/client + node-pty）
 *
 * 用法:
 *   node scripts/package-resources.js [--platform darwin|win32] [--arch arm64|x64]
 *   node scripts/package-resources.js --only webui [--platform darwin|win32] [--arch arm64|x64]
 *   node scripts/package-resources.js --only webui-copy [--platform darwin|win32] [--arch arm64|x64]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const axios = require("axios");

// ── 版本配置 ──

const PYTHON_VERSION = "3.13.13";
const PYTHON_STANDALONE_TAG = "20260414";
const NODE_VERSION = "24.15.0";
const RIPGREP_VERSION = "14.1.1";

// ── 参数解析 ──

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const targetPlatform = getArg("platform") || process.platform;
const targetArch = getArg("arch") || process.arch;
const onlyStep = getArg("only") || "";
const forceRebuildVenv = args.includes("--rebuild-venv");
const targetId = `${targetPlatform}-${targetArch}`;

console.log(`\n[package-resources] 目标: ${targetId}\n`);

// ── 路径 ──

const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT, ".cache");
const CACHE_DOWNLOADS_DIR = path.join(CACHE_DIR, "downloads");
const CACHE_ARTIFACTS_DIR = path.join(CACHE_DIR, "artifacts", targetId);
const CACHE_STAMPS_DIR = path.join(CACHE_DIR, "stamps");
const TARGET_DIR = path.join(ROOT, "resources", "targets", targetId);

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(CACHE_DOWNLOADS_DIR, { recursive: true });
fs.mkdirSync(CACHE_ARTIFACTS_DIR, { recursive: true });
fs.mkdirSync(CACHE_STAMPS_DIR, { recursive: true });
fs.mkdirSync(TARGET_DIR, { recursive: true });

// hermes-agent 和 hermes-webui 源码路径
const HERMES_AGENT_DIR = process.env.HERMES_AGENT_DIR
  || path.join(process.env.HOME || process.env.USERPROFILE || "", ".hermes", "hermes-agent");
const HERMES_WEBUI_DIR = process.env.HERMES_WEBUI_DIR
  || path.join(process.env.HOME || process.env.USERPROFILE || "", "code", "hermes-webui");

// ── 工具函数 ──

function stampFile() {
  return path.join(CACHE_STAMPS_DIR, `${targetId}.json`);
}

function readStamps() {
  const sf = stampFile();
  if (!fs.existsSync(sf)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(sf, "utf-8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function writeStamps(stamps) {
  const sf = stampFile();
  fs.writeFileSync(sf, `${JSON.stringify(stamps, null, 2)}\n`, "utf-8");
}

function isStampValid(name, version) {
  const stamps = readStamps();
  return stamps[name] === version;
}

function writeStamp(name, version) {
  const stamps = readStamps();
  stamps[name] = version;
  writeStamps(stamps);
}

function getHermesAgentCommit() {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: HERMES_AGENT_DIR,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    throw new Error(
      `无法获取 hermes-agent commit id: ${HERMES_AGENT_DIR}\n` +
      `请确认该目录是 git 仓库且可执行 git rev-parse HEAD`
    );
  }
}

function ensureUvAvailable() {
  try {
    execSync("uv --version", { stdio: "pipe" });
  } catch {
    throw new Error(
      "未检测到 uv，请先安装 uv 并确保可在 PATH 中访问（命令: uv --version）"
    );
  }
}

function resolveAxiosProxy() {
  const raw = process.env.HERMES_DOWNLOAD_PROXY
    || process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || "";
  if (!raw.trim()) return null;
  try {
    const u = new URL(raw);
    if (!u.hostname || !u.port) return null;
    return {
      protocol: u.protocol.replace(":", ""),
      host: u.hostname,
      port: Number.parseInt(u.port, 10),
      auth: u.username ? {
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password || ""),
      } : undefined,
    };
  } catch {
    console.warn(`  警告: 无法解析代理地址，忽略代理: ${raw}`);
    return null;
  }
}

function download(url, destPath) {
  const MAX_RETRIES = 3;
  const proxy = resolveAxiosProxy();

  async function run(attempt = 1) {
    console.log(
      `  下载: ${url} (attempt ${attempt}/${MAX_RETRIES})` +
      (proxy ? ` via ${proxy.protocol}://${proxy.host}:${proxy.port}` : " (direct)")
    );
    const file = fs.createWriteStream(destPath);
    try {
      const req = {
        method: "get",
        url,
        responseType: "stream",
        timeout: 300000,
        maxRedirects: 10,
        headers: { "User-Agent": "hermes-desktop" },
        validateStatus: (status) => status >= 200 && status < 400,
      };
      if (proxy) req.proxy = proxy;

      const res = await axios(req);

      const total = parseInt(res.headers["content-length"] || "0", 10);
      let downloaded = 0;
      res.data.on("data", (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          const pct = ((downloaded / total) * 100).toFixed(0);
          process.stdout.write(`\r  进度: ${pct}% (${(downloaded / 1048576).toFixed(1)} MB)`);
        }
      });

      await new Promise((resolve, reject) => {
        res.data.pipe(file);
        file.on("finish", resolve);
        file.on("error", reject);
        res.data.on("error", reject);
      });
      process.stdout.write("\n");
    } catch (err) {
      file.close();
      try { fs.unlinkSync(destPath); } catch {}
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2000));
        return run(attempt + 1);
      }
      throw err;
    }
  }

  return run();
}

async function downloadWithFallback(urls, destPath) {
  let lastErr = null;
  for (const url of urls) {
    try {
      await download(url, destPath);
      return;
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      console.warn(`  下载失败，切换备用地址: ${url}\n    -> ${msg}`);
    }
  }
  throw lastErr || new Error(`下载失败: ${urls.join(", ")}`);
}

function exec(cmd, opts = {}) {
  console.log(`  执行: ${cmd}`);
  return execSync(cmd, { stdio: "inherit", ...opts });
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.name.startsWith(".") || entry.name === "__pycache__" || entry.name === "node_modules") {
      continue;
    }
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else if (entry.isSymbolicLink()) {
      try {
        const real = fs.realpathSync(s);
        fs.copyFileSync(real, d);
      } catch {}
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function copyDirAllSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirAllSync(s, d);
    } else if (entry.isSymbolicLink()) {
      try {
        const real = fs.realpathSync(s);
        fs.copyFileSync(real, d);
      } catch {}
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function getDirSizeBytes(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += getDirSizeBytes(p);
      } else if (entry.isFile()) {
        total += fs.statSync(p).size;
      } else if (entry.isSymbolicLink()) {
        const real = fs.realpathSync(p);
        total += fs.statSync(real).size;
      }
    } catch {}
  }
  return total;
}

function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function createRuntimeZips() {
  const pythonDir = path.join(TARGET_DIR, "python");
  const venvDir = path.join(TARGET_DIR, "venv");
  const pythonZip = path.join(TARGET_DIR, "python.zip");
  const venvZip = path.join(TARGET_DIR, "venv.zip");

  if (!fs.existsSync(pythonDir)) {
    throw new Error(`无法压缩：目录不存在 ${pythonDir}`);
  }
  if (!fs.existsSync(venvDir)) {
    throw new Error(`无法压缩：目录不存在 ${venvDir}`);
  }

  console.log(`[2.5/5] 压缩 python/venv 为 zip...`);

  try { fs.unlinkSync(pythonZip); } catch {}
  try { fs.unlinkSync(venvZip); } catch {}

  // 使用 tar 生成 zip，归档内保留顶层目录名 python/ 与 venv/
  exec(`tar -a -cf "${pythonZip}" -C "${TARGET_DIR}" "python"`, { stdio: "pipe" });
  exec(`tar -a -cf "${venvZip}" -C "${TARGET_DIR}" "venv"`, { stdio: "pipe" });

  console.log(`  已生成: ${pythonZip}`);
  console.log(`  已生成: ${venvZip}\n`);
}

// ── Step 1: Python 3.13.13 ──

async function installPython() {
  const pythonDir = path.join(TARGET_DIR, "python");
  const stampVersion = `${PYTHON_VERSION}-${PYTHON_STANDALONE_TAG}`;
  const artifactRoot = path.join(CACHE_ARTIFACTS_DIR, `python-${stampVersion}`);
  const artifactPythonDir = path.join(artifactRoot, "python");

  if (isStampValid("python", stampVersion) && fs.existsSync(artifactPythonDir)) {
    console.log(`[1/5] Python ${PYTHON_VERSION} 命中产物缓存`);
    if (fs.existsSync(pythonDir)) {
      fs.rmSync(pythonDir, { recursive: true, force: true });
    }
    copyDirAllSync(artifactPythonDir, pythonDir);
    return;
  }

  console.log(`[1/5] Python ${PYTHON_VERSION} 产物缓存未命中，开始准备...`);

  const archMap = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
  };
  const triple = archMap[targetId];
  if (!triple) throw new Error(`不支持的平台: ${targetId}`);

  const filename = `cpython-${PYTHON_VERSION}+${PYTHON_STANDALONE_TAG}-${triple}-install_only.tar.gz`;
  const pythonUrlCandidates = [
    `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_STANDALONE_TAG}/${filename}`,
    `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_STANDALONE_TAG}/${filename}`,
  ];

  const cachePath = path.join(CACHE_DOWNLOADS_DIR, filename);
  if (!fs.existsSync(cachePath)) {
    console.log(`  下载缓存未命中: ${cachePath}`);
    await downloadWithFallback(pythonUrlCandidates, cachePath);
  } else {
    console.log(`  下载缓存命中: ${cachePath}`);
  }

  console.log(`  解压到产物缓存: ${artifactRoot}`);
  resetDir(artifactRoot);
  exec(`tar xzf "${cachePath}" -C "${artifactRoot}"`, { stdio: "pipe" });
  if (!fs.existsSync(artifactPythonDir)) {
    throw new Error(`Python 产物缓存生成失败: ${artifactPythonDir}`);
  }

  if (fs.existsSync(pythonDir)) {
    fs.rmSync(pythonDir, { recursive: true, force: true });
  }
  copyDirAllSync(artifactPythonDir, pythonDir);

  writeStamp("python", stampVersion);
  console.log(`  Python ${PYTHON_VERSION} 准备完成\n`);
}

// ── Step 2: 创建 venv 并安装依赖 ──

async function createVenv() {
  const venvDir = path.join(TARGET_DIR, "venv");
  const hermesAgentCommit = getHermesAgentCommit();
  const venvFingerprint = `${hermesAgentCommit}-${PYTHON_VERSION}`;
  const pythonBin = targetPlatform === "win32"
    ? path.join(TARGET_DIR, "python", "python.exe")
    : path.join(TARGET_DIR, "python", "bin", "python3.13");

  if (!fs.existsSync(HERMES_AGENT_DIR)) {
    throw new Error(
      `hermes-agent 目录不存在: ${HERMES_AGENT_DIR}\n` +
      `设置 HERMES_AGENT_DIR 环境变量指向 hermes-agent 源码`
    );
  }

  console.log(`[2/5] 创建 venv 并安装 hermes-agent...`);
  ensureUvAvailable();

  const venvPythonBin = targetPlatform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python3.13");
  const venvHermesBin = targetPlatform === "win32"
    ? path.join(venvDir, "Scripts", "hermes.exe")
    : path.join(venvDir, "bin", "hermes");
  const cacheHit = !forceRebuildVenv
    && isStampValid("venv", venvFingerprint)
    && fs.existsSync(venvPythonBin)
    && fs.existsSync(venvHermesBin);

  if (cacheHit) {
    console.log(`  venv 缓存命中: ${venvFingerprint}`);
    return;
  }

  if (fs.existsSync(venvDir)) {
    fs.rmSync(venvDir, { recursive: true, force: true });
  }
  exec(`uv venv --python "${pythonBin}" "${venvDir}"`, { stdio: "pipe" });

  // 不用 -e（editable），确保代码实际复制到 site-packages，便于在其他机器上运行
  exec(`uv pip install --python "${venvPythonBin}" "${HERMES_AGENT_DIR}[cli,pty,mcp,web,voice,messaging]"`);
  exec(`uv pip install --python "${venvPythonBin}" "pyyaml>=6.0"`, { stdio: "pipe" });

  writeStamp("venv", venvFingerprint);
  console.log(`  venv 创建完成\n`);
}

function writeRuntimeVersion() {
  const runtimeVersionPath = path.join(TARGET_DIR, "runtime-version.json");
  const payload = {
    schemaVersion: 1,
    targetId,
    pythonVersion: PYTHON_VERSION,
    hermesAgentCommit: getHermesAgentCommit(),
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(runtimeVersionPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  console.log(`  已生成: ${runtimeVersionPath}`);
}

// ── Step 3: Node.js 24 ──

async function installNodejs() {
  const runtimeDir = path.join(TARGET_DIR, "runtime");
  const artifactRoot = path.join(CACHE_ARTIFACTS_DIR, `node-${NODE_VERSION}`);
  const artifactRuntimeDir = path.join(artifactRoot, "runtime");
  const artifactNodeBin = path.join(artifactRuntimeDir, targetPlatform === "win32" ? "node.exe" : "node");

  if (isStampValid("nodejs", NODE_VERSION) && fs.existsSync(artifactNodeBin)) {
    console.log(`[3/5] Node.js ${NODE_VERSION} 命中产物缓存`);
    if (fs.existsSync(runtimeDir)) {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
    copyDirAllSync(artifactRuntimeDir, runtimeDir);
    return;
  }

  console.log(`[3/5] Node.js ${NODE_VERSION} 产物缓存未命中，开始准备...`);

  const archMap = {
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "win32-x64": "win-x64",
    "win32-arm64": "win-arm64",
  };
  const nodeArch = archMap[targetId];
  if (!nodeArch) throw new Error(`不支持的平台: ${targetId}`);

  const ext = targetPlatform === "win32" ? "zip" : "tar.gz";
  const filename = `node-v${NODE_VERSION}-${nodeArch}.${ext}`;
  const nodeUrlCandidates = [
    `https://nodejs.org/dist/v${NODE_VERSION}/${filename}`,
  ];

  const cachePath = path.join(CACHE_DOWNLOADS_DIR, filename);
  if (!fs.existsSync(cachePath)) {
    console.log(`  下载缓存未命中: ${cachePath}`);
    await downloadWithFallback(nodeUrlCandidates, cachePath);
  } else {
    console.log(`  下载缓存命中: ${cachePath}`);
  }

  resetDir(artifactRuntimeDir);

  // 解压并只提取 node 二进制
  const tmpDir = path.join(CACHE_DIR, "tmp", `node-extract-${targetId}`);
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  if (targetPlatform === "win32") {
    exec(`tar xf "${cachePath}" -C "${tmpDir}"`, { stdio: "pipe" });
    const extracted = path.join(tmpDir, `node-v${NODE_VERSION}-${nodeArch}`);
    for (const f of ["node.exe"]) {
      const src = path.join(extracted, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(artifactRuntimeDir, f));
    }
  } else {
    exec(`tar xzf "${cachePath}" -C "${tmpDir}" --strip-components=1`, { stdio: "pipe" });
    const nodeSrc = path.join(tmpDir, "bin", "node");
    if (fs.existsSync(nodeSrc)) {
      fs.copyFileSync(nodeSrc, path.join(artifactRuntimeDir, "node"));
      fs.chmodSync(path.join(artifactRuntimeDir, "node"), 0o755);
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (!fs.existsSync(artifactNodeBin)) {
    throw new Error(`Node.js 产物缓存生成失败: ${artifactNodeBin}`);
  }
  if (fs.existsSync(runtimeDir)) {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
  copyDirAllSync(artifactRuntimeDir, runtimeDir);
  writeStamp("nodejs", NODE_VERSION);
  console.log(`  Node.js ${NODE_VERSION} 准备完成\n`);
}

// ── Step 4: ripgrep ──

async function installRipgrep() {
  const toolsDir = path.join(TARGET_DIR, "tools");
  const artifactRoot = path.join(CACHE_ARTIFACTS_DIR, `ripgrep-${RIPGREP_VERSION}`);
  const artifactToolsDir = path.join(artifactRoot, "tools");
  const rgBin = targetPlatform === "win32" ? "rg.exe" : "rg";
  const artifactRgBin = path.join(artifactToolsDir, rgBin);

  if (isStampValid("ripgrep", RIPGREP_VERSION) && fs.existsSync(artifactRgBin)) {
    console.log(`[4/5] ripgrep ${RIPGREP_VERSION} 命中产物缓存`);
    if (fs.existsSync(toolsDir)) {
      fs.rmSync(toolsDir, { recursive: true, force: true });
    }
    copyDirAllSync(artifactToolsDir, toolsDir);
    return;
  }

  console.log(`[4/5] ripgrep ${RIPGREP_VERSION} 产物缓存未命中，开始准备...`);

  const archMap = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
  };
  const triple = archMap[targetId];
  if (!triple) throw new Error(`不支持的平台: ${targetId}`);

  const ext = targetPlatform === "win32" ? "zip" : "tar.gz";
  const filename = `ripgrep-${RIPGREP_VERSION}-${triple}.${ext}`;
  const ripgrepUrlCandidates = [
    `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${filename}`,
    `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${filename}`,
  ];

  const cachePath = path.join(CACHE_DOWNLOADS_DIR, filename);
  if (!fs.existsSync(cachePath)) {
    console.log(`  下载缓存未命中: ${cachePath}`);
    await downloadWithFallback(ripgrepUrlCandidates, cachePath);
  } else {
    console.log(`  下载缓存命中: ${cachePath}`);
  }

  resetDir(artifactToolsDir);

  const tmpDir = path.join(CACHE_DIR, "tmp", `ripgrep-extract-${targetId}`);
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  if (targetPlatform === "win32") {
    exec(`tar xf "${cachePath}" -C "${tmpDir}"`, { stdio: "pipe" });
  } else {
    exec(`tar xzf "${cachePath}" -C "${tmpDir}"`, { stdio: "pipe" });
  }

  // ripgrep 解压到带版本号的子目录
  const rgDest = path.join(artifactToolsDir, rgBin);

  // 递归查找 rg 二进制
  function findFile(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFile(p, name);
        if (found) return found;
      } else if (entry.name === name) {
        return p;
      }
    }
    return null;
  }

  const rgSrc = findFile(tmpDir, rgBin);
  if (rgSrc) {
    fs.copyFileSync(rgSrc, rgDest);
    if (targetPlatform !== "win32") fs.chmodSync(rgDest, 0o755);
  } else {
    throw new Error(`未找到 ${rgBin}`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (fs.existsSync(toolsDir)) {
    fs.rmSync(toolsDir, { recursive: true, force: true });
  }
  copyDirAllSync(artifactToolsDir, toolsDir);
  writeStamp("ripgrep", RIPGREP_VERSION);
  console.log(`  ripgrep ${RIPGREP_VERSION} 准备完成\n`);
}

// ── Step 5: 构建并复制 hermes-web-ui ──

async function buildWebUIArtifacts() {
  if (!fs.existsSync(HERMES_WEBUI_DIR)) {
    throw new Error(
      `hermes-webui 目录不存在: ${HERMES_WEBUI_DIR}\n` +
      `设置 HERMES_WEBUI_DIR 环境变量指向 hermes-webui 源码`
    );
  }
  console.log(`  构建 hermes-web-ui 产物...`);
  exec("pnpm install", { cwd: HERMES_WEBUI_DIR });
  exec("pnpm run build", { cwd: HERMES_WEBUI_DIR });
}

function syncWebUIArtifacts() {
  const webuiDir = path.join(TARGET_DIR, "webui");
  const sourceDistDir = path.join(HERMES_WEBUI_DIR, "dist");
  const sourceNodeModules = path.join(HERMES_WEBUI_DIR, "node_modules");

  if (fs.existsSync(webuiDir)) {
    fs.rmSync(webuiDir, { recursive: true, force: true });
  }
  fs.mkdirSync(webuiDir, { recursive: true });

  // 复制 dist/server 与 dist/client
  const sourceServerDir = path.join(sourceDistDir, "server");
  const sourceClientDir = path.join(sourceDistDir, "client");
  if (!fs.existsSync(sourceServerDir) || !fs.existsSync(sourceClientDir)) {
    throw new Error(
      `hermes-web-ui dist 产物不完整: ${sourceDistDir}\n` +
      `请检查 npm run build 是否成功生成 dist/server 和 dist/client`
    );
  }
  copyDirSync(sourceServerDir, path.join(webuiDir, "server"));
  copyDirSync(sourceClientDir, path.join(webuiDir, "client"));

  // 复制 node-pty 运行时依赖（server bundle external）
  const nodePtySrc = path.join(sourceNodeModules, "node-pty");
  const nodePtyDest = path.join(webuiDir, "node_modules", "node-pty");
  if (!fs.existsSync(nodePtySrc)) {
    throw new Error(
      `未找到 node-pty: ${nodePtySrc}\n` +
      `请确认 hermes-web-ui 依赖安装完成`
    );
  }
  copyDirSync(nodePtySrc, nodePtyDest);
}

async function copyWebUI(opts = {}) {
  const skipBuild = Boolean(opts.skipBuild);

  console.log(`[5/5] 构建并复制 hermes-web-ui...`);

  if (!skipBuild) {
    await buildWebUIArtifacts();
  }
  syncWebUIArtifacts();

  console.log(`  hermes-web-ui 打包完成\n`);
}

// ── 主流程 ──

async function main() {
  console.log("=== Hermes Desktop 资源打包 ===\n");
  console.log(`  hermes-agent: ${HERMES_AGENT_DIR}`);
  console.log(`  hermes-webui: ${HERMES_WEBUI_DIR}`);
  console.log(`  目标目录:     ${TARGET_DIR}`);
  console.log(`  缓存目录:     ${CACHE_DIR}\n`);

  if (onlyStep === "webui") {
    console.log("仅执行 Step 5: webui build + copy\n");
    await copyWebUI();
    console.log("=== 资源打包完成 ===");
    console.log(`  输出: ${TARGET_DIR}\n`);
    return;
  }

  if (onlyStep === "webui-copy") {
    console.log("仅执行 Step 5(copy): webui copy (跳过构建)\n");
    await copyWebUI({ skipBuild: true });
    console.log("=== 资源打包完成 ===");
    console.log(`  输出: ${TARGET_DIR}\n`);
    return;
  }

  await installPython();
  await createVenv();
  createRuntimeZips();
  await installNodejs();
  await installRipgrep();
  await copyWebUI();
  writeRuntimeVersion();

  console.log("=== 资源打包完成 ===");
  console.log(`  输出: ${TARGET_DIR}\n`);

  // 列出目录大小
  for (const d of ["python.zip", "venv.zip", "runtime", "tools", "webui"]) {
    const p = path.join(TARGET_DIR, d);
    if (fs.existsSync(p)) {
      const size = getDirSizeBytes(p);
      console.log(`  ${d}/: ${formatBytes(size)}`);
    }
  }
}

main().catch((err) => {
  console.error(`\n[ERROR] ${err.message || err}`);
  process.exit(1);
});
