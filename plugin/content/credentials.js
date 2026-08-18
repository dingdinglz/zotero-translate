(function (global) {
  "use strict";

  const modules = global.SmartPaperTranslatorModules = global.SmartPaperTranslatorModules || {};
  const Constants = modules.Constants || (
    typeof require === "function" ? require("./constants.js") : null
  );

  class CredentialStore {
    constructor({ services, createLoginInfo, origin, realm } = {}) {
      this.services = services || global.Services;
      this.origin = origin || Constants.CREDENTIAL_ORIGIN;
      this.realm = realm || Constants.CREDENTIAL_REALM;
      this.createLoginInfo = createLoginInfo || ((username, password) => {
        const LoginInfo = new global.Components.Constructor(
          "@mozilla.org/login-manager/loginInfo;1",
          global.Components.interfaces.nsILoginInfo,
          "init"
        );
        return new LoginInfo(this.origin, null, this.realm, username, password, "", "");
      });
    }

    async _findAll() {
      return this.services.logins.searchLoginsAsync({
        origin: this.origin,
        httpRealm: this.realm
      });
    }

    async get(provider) {
      const username = String(provider);
      const logins = await this._findAll();
      const match = logins.find((login) => login.username === username);
      return match?.password || "";
    }

    async has(provider) {
      return Boolean(await this.get(provider));
    }

    async set(provider, apiKey) {
      const username = String(provider);
      const password = String(apiKey ?? "").trim();
      const logins = await this._findAll();
      for (const login of logins) {
        if (login.username === username) this.services.logins.removeLogin(login);
      }
      if (!password) return;
      await this.services.logins.addLoginAsync(this.createLoginInfo(username, password));
    }

    async remove(provider) {
      await this.set(provider, "");
    }
  }

  modules.Credentials = { CredentialStore };
  if (typeof module !== "undefined" && module.exports) module.exports = { CredentialStore };
})(typeof globalThis !== "undefined" ? globalThis : this);
