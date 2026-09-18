// Service worker: keeps the videos collected per tab and handles downloads.

// Make the extension icon open the side panel (pinned, does not close by
// itself) instead of the traditional popup — the same pattern used by
// extensions such as MetaMask.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const videosByTab = new Map(); // tabId -> { username, items: Map<key, item> }

function getStore(tabId) {
  if (!videosByTab.has(tabId)) {
    videosByTab.set(tabId, { username: "", items: new Map() });
  }
  return videosByTab.get(tabId);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.type === "IG_VIDEOS_FOUND" && tabId != null) {
    const store = getStore(tabId);
    if (msg.username) store.username = msg.username;
    for (const v of msg.videos) {
      const key = v.shortcode || v.url.split("?")[0];
      if (!store.items.has(key)) store.items.set(key, v);
    }
    return;
  }

  if (msg.type === "SCAN_STATUS" && tabId != null) {
    chrome.runtime
      .sendMessage({ type: "SCAN_STATUS_RELAY", tabId, status: msg.status, detail: msg.detail })
      .catch(() => {});
    return;
  }

  if (msg.type === "GET_STATE") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab) return sendResponse({ tabId: null, username: "", items: [] });
      const store = getStore(tab.id);
      sendResponse({
        tabId: tab.id,
        username: store.username,
        items: Array.from(store.items.values()),
      });
    });
    return true; // async response
  }

  if (msg.type === "START_SCAN_ACTIVE_TAB") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return sendResponse({ ok: false, error: "no-active-tab" });

      // Reload the tab before scanning: if the extension was reloaded (or the
      // content script never got injected into this tab), the refresh makes
      // sure the latest script is running and captures videos from page load
      // onwards.
      chrome.runtime.sendMessage({ type: "SCAN_STATUS_RELAY", tabId: tab.id, status: "reloading" }).catch(() => {});

      await new Promise((resolve) => {
        const listener = (updatedTabId, changeInfo) => {
          if (updatedTabId === tab.id && changeInfo.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.reload(tab.id);
      });

      // small extra wait for the Instagram app to finish rendering
      await new Promise((r) => setTimeout(r, 1500));

      chrome.tabs.sendMessage(tab.id, { type: "START_SCAN", limit: msg.limit || null }, () =>
        sendResponse({ ok: true })
      );
    })();
    return true;
  }

  if (msg.type === "STOP_SCAN_ACTIVE_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab) return sendResponse({ ok: false });
      chrome.tabs.sendMessage(tab.id, { type: "STOP_SCAN" }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (msg.type === "DELETE_VIDEO") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab) return sendResponse({ ok: false });
      const store = getStore(tab.id);
      store.items.delete(msg.key);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "CLEAR_STATE") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab) return sendResponse({ ok: false });
      videosByTab.delete(tab.id);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "DOWNLOAD_VIDEOS") {
    const { username, items } = msg;
    (async () => {
      let i = 0;
      for (const item of items) {
        i++;
        const datePart = item.takenAt ? new Date(item.takenAt * 1000).toISOString().slice(0, 10) : "no-date";
        const namePart = item.shortcode || String(i).padStart(4, "0");
        const safeUser = (username || "profile").replace(/[^a-zA-Z0-9_.-]/g, "_");
        const filename = `instagram/${safeUser}/${datePart}_${namePart}.mp4`;
        try {
          await chrome.downloads.download({ url: item.url, filename, saveAs: false });
        } catch (e) {
          console.warn("Failed to download", item.url, e);
        }
        // small pause between downloads to avoid hammering the CDN
        await new Promise((r) => setTimeout(r, 300));
      }
      sendResponse({ ok: true, count: items.length });
    })();
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  videosByTab.delete(tabId);
});
