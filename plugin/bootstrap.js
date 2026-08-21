var SmartPaperTranslatorPlugin;

function log(message, error) {
  Zotero.debug("Smart Paper Translator: " + message);
  if (error) Zotero.logError(error);
}

function install({ version }) {
  log("Installed " + version);
}

async function startup({ id, version, rootURI }) {
  await Zotero.uiReadyPromise;

  const scripts = [
    "content/constants.js",
    "content/logic.js",
    "content/credentials.js",
    "content/cache.js",
    "content/chat-cache.js",
    "content/api.js",
    "content/service.js",
    "content/acp-client.js",
    "content/codex-chat.js",
    "content/item-tree-ui.js",
    "content/reader-ui.js",
    "content/codex-chat-ui.js",
    "content/main.js"
  ];
  for (const script of scripts) {
    Services.scriptloader.loadSubScript(rootURI + script);
  }

  await SmartPaperTranslatorPlugin.init({ id, version, rootURI });
  SmartPaperTranslatorPlugin.addToAllWindows();
}

function onMainWindowLoad({ window }) {
  SmartPaperTranslatorPlugin?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  SmartPaperTranslatorPlugin?.removeFromWindow(window);
}

async function shutdown() {
  try {
    await SmartPaperTranslatorPlugin?.shutdown();
  }
  catch (error) {
    log("Shutdown failed", error);
  }
  SmartPaperTranslatorPlugin = undefined;
}

function uninstall({ version }) {
  // Translation records and credentials are intentionally not deleted automatically.
  log("Uninstalled " + version);
}
