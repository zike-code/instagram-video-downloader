const statusEl = document.getElementById("status");
const countEl = document.getElementById("count");
const listEl = document.getElementById("list");
const scanBtn = document.getElementById("scanBtn");
const stopBtn = document.getElementById("stopBtn");
const downloadBtn = document.getElementById("downloadBtn");
const clearBtn = document.getElementById("clearBtn");
const limitInput = document.getElementById("limitInput");
const pickFolderBtn = document.getElementById("pickFolderBtn");
const downloadToFolderBtn = document.getElementById("downloadToFolderBtn");
const folderLabel = document.getElementById("folderLabel");
const folderLog = document.getElementById("folderLog");

let currentState = { tabId: null, username: "", items: [] };
let chosenDirHandle = null;

function itemKey(item) {
  return item.shortcode || item.url.split("?")[0];
}

function render() {
  countEl.textContent = `${currentState.items.length} video(s) found`;
  downloadBtn.disabled = currentState.items.length === 0;
  downloadToFolderBtn.disabled = currentState.items.length === 0 || !chosenDirHandle;

  listEl.innerHTML = "";
  for (const item of currentState.items) {
    const div = document.createElement("div");
    div.className = "item";

    const img = document.createElement("img");
    img.src = item.thumb || "";
    div.appendChild(img);

    const cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = item.caption || item.shortcode || "(no caption)";
    div.appendChild(cap);

    const actions = document.createElement("div");
    actions.className = "actions";

    const downloadOneBtn = document.createElement("button");
    downloadOneBtn.className = "download-one-btn";
    downloadOneBtn.title = "Download only this video";
    downloadOneBtn.textContent = "↓";
    downloadOneBtn.addEventListener("click", () => downloadOne(item, downloadOneBtn));
    actions.appendChild(downloadOneBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-btn";
    deleteBtn.title = "Remove this video from the list";
    deleteBtn.textContent = "×";
    deleteBtn.addEventListener("click", () => deleteOne(item));
    actions.appendChild(deleteBtn);

    div.appendChild(actions);
    listEl.appendChild(div);
  }
}

function downloadOne(item, btnEl) {
  if (btnEl) btnEl.disabled = true;
  statusEl.textContent = "Downloading 1 video...";
  chrome.runtime.sendMessage(
    { type: "DOWNLOAD_VIDEOS", username: currentState.username, items: [item] },
    (res) => {
      statusEl.textContent = res && res.ok ? "Video downloaded." : "Download failed.";
      if (btnEl) btnEl.disabled = false;
    }
  );
}

function deleteOne(item) {
  chrome.runtime.sendMessage({ type: "DELETE_VIDEO", key: itemKey(item) }, () => {
    currentState.items = currentState.items.filter((i) => itemKey(i) !== itemKey(item));
    render();
  });
}

function refreshState() {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
    if (!res) return;
    currentState = { tabId: res.tabId, username: res.username, items: res.items };
    render();
  });
}

scanBtn.addEventListener("click", () => {
  const rawLimit = parseInt(limitInput.value, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null;

  scanBtn.disabled = true;
  stopBtn.disabled = false;
  statusEl.textContent = "Reloading the page...";
  chrome.runtime.sendMessage({ type: "START_SCAN_ACTIVE_TAB", limit });
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_SCAN_ACTIVE_TAB" });
  scanBtn.disabled = false;
  stopBtn.disabled = true;
  statusEl.textContent = "Scan stopped.";
});

downloadBtn.addEventListener("click", () => {
  downloadBtn.disabled = true;
  statusEl.textContent = "Downloading videos...";
  chrome.runtime.sendMessage(
    { type: "DOWNLOAD_VIDEOS", username: currentState.username, items: currentState.items },
    (res) => {
      statusEl.textContent = res && res.ok ? `Download started for ${res.count} video(s).` : "Download failed.";
      downloadBtn.disabled = false;
    }
  );
});

clearBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_STATE" }, () => {
    currentState.items = [];
    render();
  });
});

// --- Download into a folder chosen by the user (File System Access API) ---
// The side panel does not close by itself (unlike the traditional popup), so
// this can happen right here without opening a separate tab.

function logFolderLine(text, ok) {
  const div = document.createElement("div");
  div.className = "log-item";
  const label = document.createElement("span");
  label.textContent = text;
  const status = document.createElement("span");
  status.className = ok ? "ok" : "fail";
  status.textContent = ok ? "OK" : "failed";
  div.appendChild(label);
  div.appendChild(status);
  folderLog.prepend(div);
}

function buildFilename(item, index) {
  const datePart = item.takenAt ? new Date(item.takenAt * 1000).toISOString().slice(0, 10) : "no-date";
  const namePart = item.shortcode || String(index + 1).padStart(4, "0");
  return `${datePart}_${namePart}.mp4`;
}

// Gets the video bytes by asking the content script (running on the Instagram
// page itself) to do the fetch — a direct fetch from here (the extension
// panel) is blocked by the CDN over CORS, since the origin is not
// instagram.com.
function fetchVideoBlob(url) {
  return new Promise((resolve, reject) => {
    if (currentState.tabId == null) return reject(new Error("Instagram tab not found"));
    chrome.tabs.sendMessage(currentState.tabId, { type: "FETCH_VIDEO_BYTES", url }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res || !res.ok) return reject(new Error((res && res.error) || "unknown failure"));
      fetch(`data:video/mp4;base64,${res.base64}`)
        .then((r) => r.blob())
        .then(resolve)
        .catch(reject);
    });
  });
}

pickFolderBtn.addEventListener("click", async () => {
  try {
    chosenDirHandle = await window.showDirectoryPicker();
    folderLabel.textContent = `Chosen folder: ${chosenDirHandle.name}`;
    render();
  } catch (e) {
    // the user cancelled the folder picker
  }
});

downloadToFolderBtn.addEventListener("click", async () => {
  if (!chosenDirHandle || currentState.items.length === 0) return;
  downloadToFolderBtn.disabled = true;
  pickFolderBtn.disabled = true;
  folderLog.innerHTML = "";

  const items = currentState.items;
  let done = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const filename = buildFilename(item, i);
    statusEl.textContent = `Downloading into the chosen folder: ${i + 1}/${items.length}...`;
    try {
      const blob = await fetchVideoBlob(item.url);
      const fileHandle = await chosenDirHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      done++;
      logFolderLine(filename, true);
    } catch (e) {
      console.warn("Failed to download", item.url, e);
      logFolderLine(`${filename} (${e.message || e})`, false);
    }
  }

  statusEl.textContent = `Done: ${done}/${items.length} video(s) saved into "${chosenDirHandle.name}".`;
  pickFolderBtn.disabled = false;
  render();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SCAN_STATUS_RELAY") {
    const map = {
      reloading: "Reloading the page...",
      "scanning-posts": "Scrolling the posts feed...",
      "opening-post": "Opening posts to capture the video...",
      "opening-reels": "Opening the Reels tab...",
      "scanning-reels": "Scrolling the Reels...",
      done: "Scan complete.",
    };
    const base = map[msg.status] || msg.status;
    statusEl.textContent = msg.detail ? `${base} (${msg.detail})` : base;
    if (msg.status === "done") {
      scanBtn.disabled = false;
      stopBtn.disabled = true;
    }
    refreshState();
  }
});

// Refresh the list periodically while the panel is open
refreshState();
setInterval(refreshState, 1500);
