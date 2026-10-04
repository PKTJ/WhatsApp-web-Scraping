// Side panel dibuka lewat ikon toolbar dan tetap hidup saat pengguna berpindah
// tab atau menutup/membuka Chrome. Progres disimpan di chrome.storage.local
// supaya panel yang dibuka kembali dapat memulihkan tampilan terakhir.
const SESSION_KEY = "exporter_session_state";

chrome.runtime.onInstalled.addListener(() => {
  // openPanelOnActionClick memastikan klik ikon membuka side panel tanpa perlu
  // handler manual per tab.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "DOWNLOAD_FILE_URL") {
    const filename = sanitizeDownloadPath(message.filename || "export.zip");
    const url = typeof message.url === "string" ? message.url : "";

    if (!url) {
      sendResponse({ ok: false, error: "URL file unduhan tidak valid." });
      return undefined;
    }

    startDownload({
      url,
      filename,
      saveAs: false,
      conflictAction: message.overwrite === true ? "overwrite" : "uniquify"
    }).then(sendResponse);
    return true;
  }

  if (message?.type === "SAVE_SESSION_STATE") {
    saveSessionState(message.state).then(sendResponse);
    return true;
  }

  if (message?.type === "LOAD_SESSION_STATE") {
    loadSessionState().then(sendResponse);
    return true;
  }

  if (message?.type === "CLEAR_SESSION_STATE") {
    chrome.storage.local
      .remove(SESSION_KEY)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  // Progres scan/ekspor ikut dicatat agar panel yang tertutup di tengah proses
  // tidak kehilangan riwayat saat dibuka lagi.
  if (message?.type === "SCAN_PROGRESS" || message?.type === "EXPORT_PROGRESS") {
    recordProgress(message).catch(() => {});
    return undefined;
  }

  if (message?.type === "TRUSTED_CLICK") {
    trustedClick(message.x, message.y)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  return undefined;
});

async function trustedClick(x, y) {
  const [tab] = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  if (!tab?.id) {
    return { ok: false, error: "Tab WhatsApp Web aktif tidak ditemukan." };
  }

  const clientX = Math.round(Number(x));
  const clientY = Math.round(Number(y));
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    return { ok: false, error: "Koordinat klik tidak valid." };
  }

  const target = { tabId: tab.id };
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: clientX,
      y: clientY,
      button: "none"
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: clientX,
      y: clientY,
      button: "left",
      clickCount: 1
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: clientX,
      y: clientY,
      button: "left",
      clickCount: 1
    });
    return { ok: true };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function saveSessionState(state) {
  try {
    const previous = await readSessionState();
    const merged = {
      ...previous,
      ...(state && typeof state === "object" ? state : {}),
      updated_at: Date.now()
    };
    await chrome.storage.local.set({ [SESSION_KEY]: merged });
    return { ok: true, state: merged };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function loadSessionState() {
  try {
    return { ok: true, state: await readSessionState() };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function readSessionState() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  const state = stored?.[SESSION_KEY];
  return state && typeof state === "object" ? state : {};
}

async function recordProgress(message) {
  const previous = await readSessionState();

  if (message.type === "SCAN_PROGRESS") {
    await chrome.storage.local.set({
      [SESSION_KEY]: {
        ...previous,
        last_scan_progress: message,
        updated_at: Date.now()
      }
    });
    return;
  }

  // Hasil per chat disimpan sebagai daftar agar urutan tetap dan entri lama
  // tidak hilang saat panel ditutup di tengah ekspor.
  const results = Array.isArray(previous.live_results) ? [...previous.live_results] : [];
  const incoming = message.result;

  if (incoming?.chat_name) {
    const key = incoming.chat_id ||
      `${incoming.chat_name}::${incoming.community_name || ""}`;
    const index = results.findIndex((item) => item.__key === key);
    const entry = { ...(index >= 0 ? results[index] : {}), ...incoming, __key: key };
    if (index >= 0) results[index] = entry;
    else results.push(entry);
  }

  await chrome.storage.local.set({
    [SESSION_KEY]: {
      ...previous,
      live_results: results,
      last_export_progress: {
        current_chat_index: message.current_chat_index,
        total_chats: message.total_chats
      },
      updated_at: Date.now()
    }
  });
}

async function startDownload({ url, filename, saveAs, conflictAction = "uniquify" }) {
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs,
      conflictAction
    });

    return { ok: true, downloadId };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function sanitizeDownloadPath(value) {
  const normalized = String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment
        .replace(/[<>:"|?*\u0000-\u001F]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^\.+$/, "_")
        .slice(0, 120) || "_"
    )
    .join("/");

  return normalized.slice(0, 240) || `whatsapp-export-${Date.now()}`;
}
