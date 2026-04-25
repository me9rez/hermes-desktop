import { ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  resolveHermesHome,
  resolveResourcesPath,
  resolveRuntimeDataPath,
  resolveUserConfigPath,
  resolveUserEnvPath,
} from "./constants";
import { SetupManager } from "./setup-manager";
import * as log from "./logger";

interface SetupIpcOptions {
  setupManager: SetupManager;
}

function extractRuntimeZips(): void {
  const sourceBase = resolveResourcesPath();
  const runtimeBase = resolveRuntimeDataPath();
  const pythonZip = path.join(sourceBase, "python.zip");
  const venvZip = path.join(sourceBase, "venv.zip");

  if (!fs.existsSync(pythonZip)) {
    throw new Error(`缺少运行时归档文件: ${pythonZip}`);
  }
  if (!fs.existsSync(venvZip)) {
    throw new Error(`缺少运行时归档文件: ${venvZip}`);
  }

  fs.mkdirSync(runtimeBase, { recursive: true });

  // 清理旧目录后再解压，避免增量覆盖带来残留文件。
  fs.rmSync(path.join(runtimeBase, "python"), { recursive: true, force: true });
  fs.rmSync(path.join(runtimeBase, "venv"), { recursive: true, force: true });

  execFileSync("tar", ["-xf", pythonZip, "-C", runtimeBase], { stdio: "pipe" });
  execFileSync("tar", ["-xf", venvZip, "-C", runtimeBase], { stdio: "pipe" });
}

export function registerSetupIpc(opts: SetupIpcOptions): void {
  const { setupManager } = opts;

  // Setup 完成
  ipcMain.handle("setup:complete", async (_e, config: {
    provider: string;
    apiKey: string;
    model: string;
    baseUrl?: string;
  }) => {
    try {
      extractRuntimeZips();

      const hermesHome = resolveHermesHome();
      fs.mkdirSync(hermesHome, { recursive: true });

      // 写入 config.yaml
      const configLines = [
        "model:",
        `  default: ${config.model}`,
        `  provider: ${config.provider}`,
      ];

      // 自定义 base URL（用于 Ollama / Custom 提供商）
      if (config.baseUrl) {
        configLines.push(`  base_url: ${config.baseUrl}`);
      }

      configLines.push(
        "agent:",
        "  max_turns: 90",
        "  reasoning_effort: medium",
        "terminal:",
        "  backend: local",
        "compression:",
        "  enabled: true",
        "  threshold: 0.5",
        "",
      );

      fs.writeFileSync(resolveUserConfigPath(), configLines.join("\n"), "utf-8");

      // 写入 .env
      const envPath = resolveUserEnvPath();
      const envLines: string[] = [];

      const keyEnvMap: Record<string, string> = {
        openrouter: "OPENROUTER_API_KEY",
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        gemini: "GOOGLE_API_KEY",
        google: "GOOGLE_API_KEY",
        deepseek: "DEEPSEEK_API_KEY",
      };

      if (config.provider === "ollama") {
        // Ollama: set OPENAI_API_KEY (placeholder) and OPENAI_API_BASE
        const apiKey = config.apiKey || "ollama";
        envLines.push(`OPENAI_API_KEY=${apiKey}`);
        if (config.baseUrl) {
          envLines.push(`OPENAI_API_BASE=${config.baseUrl}`);
        }
      } else if (config.provider === "custom") {
        // Custom OpenAI-compatible: set OPENAI_API_KEY and OPENAI_API_BASE
        envLines.push(`OPENAI_API_KEY=${config.apiKey}`);
        if (config.baseUrl) {
          envLines.push(`OPENAI_API_BASE=${config.baseUrl}`);
        }
      } else {
        // Standard provider
        const envVar = keyEnvMap[config.provider] || `${config.provider.toUpperCase()}_API_KEY`;
        envLines.push(`${envVar}=${config.apiKey}`);
      }

      envLines.push("");
      fs.writeFileSync(envPath, envLines.join("\n"), "utf-8");

      log.info(`[setup] 配置写入完成: provider=${config.provider} model=${config.model}${config.baseUrl ? ` baseUrl=${config.baseUrl}` : ""}`);
      const ok = await setupManager.complete();
      return { success: ok };
    } catch (err: any) {
      log.error(`[setup] 配置写入失败: ${err?.message ?? err}`);
      return { success: false, error: err?.message ?? String(err) };
    }
  });

  // 修复运行时（仅解压 python/venv，不改用户配置）
  ipcMain.handle("setup:repair-runtime", async () => {
    try {
      extractRuntimeZips();
      const ok = await setupManager.complete();
      return { success: ok };
    } catch (err: any) {
      log.error(`[setup] 运行时修复失败: ${err?.message ?? err}`);
      return { success: false, error: err?.message ?? String(err) };
    }
  });

  // 验证 API key
  ipcMain.handle("setup:validate-key", async (_e, _provider: string, apiKey: string) => {
    return { valid: Boolean(apiKey?.trim()) };
  });
}
