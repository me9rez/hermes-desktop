// ============================================
// Hermes Desktop Setup — 配置向导
// ============================================

(function () {
  "use strict";

  // ── 状态 ──

  let currentStep = 1;
  let selectedProvider = null;
  let selectedModel = null;
  let isCustomProvider = false;
  let isApiKeyOptional = false;
  let defaultBaseUrl = "";

  // ── DOM ──

  const steps = document.querySelectorAll(".step");
  const progressFill = document.getElementById("progressFill");
  const providerCards = document.querySelectorAll(".provider-card");
  const apiKeyInput = document.getElementById("apiKeyInput");
  const apiKeyError = document.getElementById("apiKeyError");
  const apikeySubtitle = document.getElementById("apikeySubtitle");
  const step3Title = document.getElementById("step3Title");
  const customFields = document.getElementById("customFields");
  const baseUrlInput = document.getElementById("baseUrlInput");
  const modelNameInput = document.getElementById("modelNameInput");
  const baseUrlLabel = document.getElementById("baseUrlLabel");
  const modelNameLabel = document.getElementById("modelNameLabel");
  const apiKeyHint = document.getElementById("apiKeyHint");
  const apiKeyField = document.getElementById("apiKeyField");
  const btnStart = document.getElementById("btnStart");
  const btnBackToProvider = document.getElementById("btnBackToProvider");
  const btnFinish = document.getElementById("btnFinish");
  const btnToggleKey = document.getElementById("btnToggleKey");
  const step1Error = document.getElementById("step1Error");

  // ── 国际化 ──

  const query = new URLSearchParams(window.location.search);
  const lang = query.get("lang") || "en";
  const setupMode = query.get("mode") || "normal";
  const isRepairMode = setupMode === "repair";

  const I18N = {
    zh: {
      "welcome.title": "欢迎使用 Hermes Desktop",
      "welcome.subtitle": "Nous Research 出品的一键 AI 助手。让我们开始配置。",
      "welcome.start": "开始配置",
      "repair.title": "修复运行时环境",
      "repair.subtitle": "检测到 Python/venv 缺失，点击下方按钮自动修复。",
      "repair.start": "修复并启动",
      "provider.title": "选择 AI 服务商",
      "provider.subtitle": "选择你要使用的大模型提供商。",
      "provider.ollama.desc": "本地模型",
      "provider.custom.name": "自定义（OpenAI 兼容）",
      "provider.custom.desc": "任何 OpenAI 兼容 API",
      "apikey.title": "输入 API Key",
      "apikey.finish": "完成配置",
      "common.back": "返回",
      "done.title": "配置完成！",
      "done.subtitle": "Hermes Agent 正在启动，请稍候...",
    },
    en: {},
  };

  function t(key) {
    const strings = I18N[lang] || {};
    return strings[key] || null;
  }

  function applyI18n() {
    const strings = I18N[lang] || {};
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (strings[key]) el.textContent = strings[key];
    });
  }

  // ── 步骤导航 ──

  function goToStep(n) {
    currentStep = n;
    steps.forEach((s, i) => {
      s.classList.toggle("active", i === n - 1);
    });
    if (isRepairMode) {
      progressFill.style.width = n === 4 ? "100%" : "0%";
    } else {
      const totalSteps = 4;
      progressFill.style.width = `${((n - 1) / (totalSteps - 1)) * 100}%`;
    }
  }

  // ── 表单验证 ──

  function validateStep3() {
    if (isCustomProvider) {
      const modelVal = modelNameInput.value.trim();
      const baseUrlVal = baseUrlInput.value.trim();
      const apiKeyVal = apiKeyInput.value.trim();

      if (!modelVal || !baseUrlVal) {
        btnFinish.disabled = true;
        return;
      }
      if (!isApiKeyOptional && apiKeyVal.length < 8) {
        btnFinish.disabled = true;
        return;
      }
      btnFinish.disabled = false;
    } else {
      const val = apiKeyInput.value.trim();
      btnFinish.disabled = val.length < 8;
    }
    apiKeyError.style.display = "none";
  }

  // ── Provider 选择 ──

  providerCards.forEach((card) => {
    card.addEventListener("click", () => {
      providerCards.forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      selectedProvider = card.dataset.provider;
      selectedModel = card.dataset.model;
      isCustomProvider = card.dataset.custom === "true";
      isApiKeyOptional = card.dataset.apikeyOptional === "true";
      defaultBaseUrl = card.dataset.baseUrl || "";

      if (isCustomProvider) {
        // Show custom fields
        customFields.style.display = "block";
        baseUrlInput.value = defaultBaseUrl;
        modelNameInput.value = "";
        apiKeyInput.value = "";

        if (selectedProvider === "ollama") {
          step3Title.textContent = t("apikey.title.ollama") ||
            (lang === "zh" ? "配置 Ollama" : "Configure Ollama");
          apikeySubtitle.textContent = lang === "zh"
            ? "请确认 Ollama 服务地址并输入模型名称。"
            : "Confirm your Ollama server address and enter the model name.";
          apiKeyHint.textContent = lang === "zh"
            ? "Ollama 通常不需要 API Key，可留空。"
            : "Ollama typically does not require an API key. You can leave this empty.";
          apiKeyHint.style.display = "block";
          apiKeyInput.placeholder = lang === "zh" ? "可选" : "Optional";
        } else {
          step3Title.textContent = t("apikey.title.custom") ||
            (lang === "zh" ? "配置自定义服务" : "Configure Custom Provider");
          apikeySubtitle.textContent = lang === "zh"
            ? "请输入 OpenAI 兼容 API 的地址、模型名和 API Key。"
            : "Enter the endpoint URL, model name, and API key for your OpenAI-compatible service.";
          apiKeyHint.style.display = "none";
          apiKeyInput.placeholder = "sk-...";
        }

        baseUrlLabel.textContent = lang === "zh" ? "服务地址 (Base URL)" : "Base URL";
        modelNameLabel.textContent = lang === "zh" ? "模型名称" : "Model Name";
      } else {
        // Standard provider — hide custom fields
        customFields.style.display = "none";
        apiKeyHint.style.display = "none";
        apiKeyInput.placeholder = "sk-...";

        const providerLabels = {
          anthropic: "Anthropic",
          openai: "OpenAI",
          gemini: "Google AI Studio",
          openrouter: "OpenRouter",
          deepseek: "DeepSeek",
        };
        const label = providerLabels[selectedProvider] || selectedProvider;

        step3Title.textContent = t("apikey.title") || "Enter Your API Key";
        apikeySubtitle.textContent = lang === "zh"
          ? `请粘贴你的 ${label} API Key。`
          : `Paste your ${label} API key below.`;
      }

      apiKeyInput.value = "";
      validateStep3();
      goToStep(3);
    });
  });

  // ── 输入事件 ──

  apiKeyInput.addEventListener("input", validateStep3);
  baseUrlInput.addEventListener("input", validateStep3);
  modelNameInput.addEventListener("input", validateStep3);

  btnToggleKey.addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  });

  // ── 按钮事件 ──

  btnStart.addEventListener("click", async () => {
    if (!isRepairMode) {
      goToStep(2);
      return;
    }

    btnStart.disabled = true;
    btnStart.textContent = lang === "zh" ? "修复中..." : "Repairing...";
    step1Error.style.display = "none";

    try {
      const result = await window.electronAPI.invoke("setup:repair-runtime");
      if (result.success) {
        goToStep(4);
      } else {
        step1Error.textContent = result.error || "Runtime repair failed";
        step1Error.style.display = "block";
        btnStart.disabled = false;
        btnStart.textContent = t("repair.start") || "Repair and Start";
      }
    } catch (err) {
      step1Error.textContent = err.message || "Runtime repair failed";
      step1Error.style.display = "block";
      btnStart.disabled = false;
      btnStart.textContent = t("repair.start") || "Repair and Start";
    }
  });
  btnBackToProvider.addEventListener("click", () => goToStep(2));

  btnFinish.addEventListener("click", async () => {
    const apiKey = apiKeyInput.value.trim();

    if (isCustomProvider) {
      const baseUrl = baseUrlInput.value.trim();
      const modelName = modelNameInput.value.trim();
      if (!baseUrl || !modelName) return;
      if (!isApiKeyOptional && !apiKey) return;
      selectedModel = modelName;
    } else {
      if (!apiKey || !selectedProvider) return;
    }

    btnFinish.disabled = true;
    btnFinish.textContent = lang === "zh" ? "保存中..." : "Saving...";

    try {
      const payload = {
        provider: selectedProvider,
        apiKey: apiKey || "",
        model: selectedModel,
      };

      if (isCustomProvider) {
        payload.baseUrl = baseUrlInput.value.trim();
      }

      const result = await window.electronAPI.invoke("setup:complete", payload);

      if (result.success) {
        goToStep(4);
      } else {
        apiKeyError.textContent = result.error || "Setup failed";
        apiKeyError.style.display = "block";
        btnFinish.disabled = false;
        btnFinish.textContent = lang === "zh" ? "完成配置" : "Complete Setup";
      }
    } catch (err) {
      apiKeyError.textContent = err.message || "Unknown error";
      apiKeyError.style.display = "block";
      btnFinish.disabled = false;
      btnFinish.textContent = lang === "zh" ? "完成配置" : "Complete Setup";
    }
  });

  // ── 初始化 ──

  applyI18n();

  if (isRepairMode) {
    const step1Title = document.querySelector("#step1 h1");
    const step1Subtitle = document.querySelector("#step1 .subtitle");
    if (step1Title) {
      step1Title.textContent = t("repair.title") || "Repair Runtime Environment";
    }
    if (step1Subtitle) {
      step1Subtitle.textContent = t("repair.subtitle")
        || "Python/venv is missing. Click below to repair automatically.";
    }
    btnStart.textContent = t("repair.start") || "Repair and Start";

    document.getElementById("step2").style.display = "none";
    document.getElementById("step3").style.display = "none";
  }

  goToStep(1);
})();
