"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CredentialStore } = require("../plugin/content/credentials.js");

test("API keys are isolated by provider in Login Manager", async () => {
  const logins = [];
  const services = {
    logins: {
      async searchLoginsAsync() {
        return logins.slice();
      },
      removeLogin(login) {
        logins.splice(logins.indexOf(login), 1);
      },
      async addLoginAsync(login) {
        logins.push(login);
      }
    }
  };
  const store = new CredentialStore({
    services,
    createLoginInfo: (username, password) => ({ username, password })
  });

  await store.set("deepseek", "sk-deepseek");
  await store.set("custom", "sk-custom");
  assert.equal(await store.get("deepseek"), "sk-deepseek");
  assert.equal(await store.get("custom"), "sk-custom");
  assert.equal(await store.has("deepseek"), true);

  await store.set("deepseek", "sk-replaced");
  assert.equal(await store.get("deepseek"), "sk-replaced");
  assert.equal(logins.filter((login) => login.username === "deepseek").length, 1);

  await store.remove("deepseek");
  assert.equal(await store.get("deepseek"), "");
  assert.equal(await store.get("custom"), "sk-custom");
});
