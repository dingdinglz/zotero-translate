(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (
    typeof require === "function" ? require("./constants.js") : null
  );
  const Logic = modules.Logic || (
    typeof require === "function" ? require("./logic.js") : null
  );

  function mapAPIError(error) {
    if (error instanceof Logic.SmartTranslatorError) return error;
    const status = Number(error?.xmlhttp?.status || error?.status || 0) || null;
    if (status === 401 || status === 403) {
      return new Logic.SmartTranslatorError(
        "API_AUTH",
        "API 鉴权失败，请检查 API Key",
        { status }
      );
    }
    if (status === 429) {
      return new Logic.SmartTranslatorError(
        "API_RATE_LIMIT",
        "API 请求过于频繁或额度不足，请稍后重试",
        { status }
      );
    }
    if (status && status >= 500) {
      return new Logic.SmartTranslatorError(
        "API_SERVER",
        `API 服务暂时不可用（HTTP ${status}）`,
        { status }
      );
    }
    if (error?.name === "TimeoutException" || /timeout/iu.test(String(error?.message || ""))) {
      return new Logic.SmartTranslatorError("API_TIMEOUT", "API 请求超时，请稍后重试");
    }
    if (error?.name === "CancelledException" || /cancel/iu.test(String(error?.message || ""))) {
      return new Logic.SmartTranslatorError("API_CANCELLED", "翻译请求已取消");
    }
    if (status) {
      return new Logic.SmartTranslatorError(
        "API_HTTP",
        `API 请求失败（HTTP ${status}）`,
        { status }
      );
    }
    return new Logic.SmartTranslatorError("API_NETWORK", "无法连接 API 服务");
  }

  function readResponseJSON(xhr) {
    if (xhr?.response && typeof xhr.response === "object") return xhr.response;
    if (typeof xhr?.responseText === "string" && xhr.responseText.trim()) {
      try {
        return JSON.parse(xhr.responseText);
      }
      catch (error) {
        throw new Logic.SmartTranslatorError("API_RESPONSE_FORMAT", "API 返回了无效的 JSON", { cause: error });
      }
    }
    throw new Logic.SmartTranslatorError("API_RESPONSE_EMPTY", "API 返回内容为空");
  }

  function extractTranslation(xhr) {
    const response = readResponseJSON(xhr);
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Logic.SmartTranslatorError(
        "API_RESPONSE_FORMAT",
        "API 响应缺少 choices[0].message.content"
      );
    }
    const translation = content.trim();
    if (!translation) {
      throw new Logic.SmartTranslatorError("API_RESPONSE_EMPTY", "API 返回的译文为空");
    }
    return translation;
  }

  class OpenAIChatClient {
    constructor({ request, timeoutMS } = {}) {
      this.request = request;
      this.timeoutMS = timeoutMS || Constants.REQUEST_TIMEOUT_MS;
    }

    async complete({ config, apiKey, prompt, maxTokens, registerCancel }) {
      if (config.provider === "deepseek" && !apiKey) {
        throw new Logic.SmartTranslatorError("CONFIG_API_KEY", "请先保存 DeepSeek API Key");
      }
      const payload = {
        model: config.model,
        messages: [
          { role: "system", content: Constants.SYSTEM_MESSAGE },
          { role: "user", content: prompt }
        ],
        stream: false
      };
      if (config.provider === "deepseek") payload.thinking = { type: "disabled" };
      if (Number.isInteger(maxTokens) && maxTokens > 0) payload.max_tokens = maxTokens;

      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      let unregisterCancel = null;
      try {
        const xhr = await this.request("POST", config.endpoint, {
          body: JSON.stringify(payload),
          headers,
          responseType: "json",
          timeout: this.timeoutMS,
          errorDelayMax: 0,
          anon: true,
          noCache: true,
          debug: false,
          logBodyLength: 0,
          cancellerReceiver: (cancel) => {
            unregisterCancel = registerCancel?.(cancel) || null;
          }
        });
        return extractTranslation(xhr);
      }
      catch (error) {
        throw mapAPIError(error);
      }
      finally {
        unregisterCancel?.();
      }
    }
  }

  modules.API = { OpenAIChatClient, mapAPIError, readResponseJSON, extractTranslation };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { OpenAIChatClient, mapAPIError, readResponseJSON, extractTranslation };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
