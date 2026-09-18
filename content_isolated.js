// Runs in the isolated world: receives the videos captured by content_main.js
// (via postMessage), forwards them to the background worker, and auto-scrolls
// the profile/reels to make Instagram load more posts.

const SOURCE = "ig-video-grabber";

function getUsernameFromUrl() {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "";
  const reserved = ["p", "reel", "reels", "stories", "explore", "direct", "accounts"];
  if (reserved.includes(parts[0])) return "";
  return parts[0];
}

// While a scan is running we only accept videos whose shortcode appeared in
// the profile's own grid (posts/reels we listed ourselves). This avoids
// capturing "Suggested"/"For you" videos that Instagram injects into the
// feed, or recommended reels that autoplay in sequence once a profile reel
// is opened.
let allowedShortcodes = null;

function shortcodeFromHref(href) {
  const m = (href || "").match(/\/(?:p|reel|reels)\/([^/?#]+)/);
  return m ? m[1] : null;
}

function filterAllowed(videos) {
  if (!allowedShortcodes || allowedShortcodes.size === 0) return videos;
  return videos.filter((v) => v.shortcode && allowedShortcodes.has(v.shortcode));
}

// chrome.runtime can become invalid (e.g. the extension was reloaded while
// the page stayed open) — without this guard an error here silently kills the
// rest of the scan flow, leaving it stuck forever.
function safeSend(msg) {
  try {
    chrome.runtime.sendMessage(msg);
  } catch (e) {
    /* extension context invalidated, ignore */
  }
}

// Optional video limit chosen by the user: once reached we stop scanning and
// opening posts instead of sweeping the whole profile.
let videoLimit = null;
let foundCount = 0;
const reportedKeys = new Set();

function reportVideos(videos) {
  const allowed = filterAllowed(videos);
  const fresh = [];
  for (const v of allowed) {
    const key = v.shortcode || v.url.split("?")[0];
    if (reportedKeys.has(key)) continue;
    reportedKeys.add(key);
    fresh.push(v);
  }
  if (fresh.length === 0) return;

  foundCount += fresh.length;
  safeSend({
    type: "IG_VIDEOS_FOUND",
    username: getUsernameFromUrl(),
    videos: fresh,
  });

  if (videoLimit && foundCount >= videoLimit) {
    scanning = false;
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== SOURCE || !Array.isArray(data.videos)) return;
  reportVideos(data.videos);
});

// --- Scan data already embedded in the page. Small profiles make no extra ---
// --- request at all: their posts arrive complete in the initial HTML,     ---
// --- inside <script type="application/json"> tags.                        ---

function extractCaption(node) {
  if (!node || typeof node !== "object") return "";
  if (typeof node.caption === "string") return node.caption;
  if (node.caption && typeof node.caption.text === "string") return node.caption.text;
  if (
    node.edge_media_to_caption &&
    Array.isArray(node.edge_media_to_caption.edges) &&
    node.edge_media_to_caption.edges[0]
  ) {
    return node.edge_media_to_caption.edges[0].node?.text || "";
  }
  return "";
}

function extractThumb(node) {
  if (!node || typeof node !== "object") return "";
  if (typeof node.display_url === "string") return node.display_url;
  if (typeof node.thumbnail_url === "string") return node.thumbnail_url;
  if (
    node.image_versions2 &&
    Array.isArray(node.image_versions2.candidates) &&
    node.image_versions2.candidates[0]
  ) {
    return node.image_versions2.candidates[0].url || "";
  }
  return "";
}

function extractVideosFromData(obj, results, seen, depth) {
  if (!obj || typeof obj !== "object" || depth > 12) return;

  if (Array.isArray(obj)) {
    for (const item of obj) extractVideosFromData(item, results, seen, depth + 1);
    return;
  }

  let url = "";
  if (Array.isArray(obj.video_versions) && obj.video_versions[0] && obj.video_versions[0].url) {
    url = obj.video_versions[0].url;
  } else if (typeof obj.video_url === "string" && obj.video_url) {
    url = obj.video_url;
  }

  if (url) {
    const shortcode = obj.code || obj.shortcode || "";
    const key = shortcode || url.split("?")[0];
    if (!seen.has(key)) {
      seen.add(key);
      results.push({
        url,
        shortcode,
        caption: extractCaption(obj).slice(0, 120),
        thumb: extractThumb(obj),
        takenAt: obj.taken_at || obj.taken_at_timestamp || null,
      });
    }
  }

  for (const k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      extractVideosFromData(obj[k], results, seen, depth + 1);
    }
  }
}

const scannedScripts = new WeakSet();

function scanJsonScriptTags() {
  const scripts = document.querySelectorAll('script[type="application/json"]');
  const results = [];
  const seen = new Set();

  for (const script of scripts) {
    if (scannedScripts.has(script)) continue;
    scannedScripts.add(script);
    if (!script.textContent || !script.textContent.includes("video_ve") && !script.textContent.includes("video_url")) {
      continue;
    }
    try {
      const data = JSON.parse(script.textContent);
      extractVideosFromData(data, results, seen, 0);
    } catch (e) {
      /* not relevant JSON, ignore */
    }
  }

  reportVideos(results);
}

// runs once on load, then watches for <script> tags inserted later
// (e.g. when switching between the Posts and Reels tabs of a profile)
scanJsonScriptTags();
new MutationObserver(() => scanJsonScriptTags()).observe(document.documentElement, {
  childList: true,
  subtree: true,
});

// --- Auto-scroll to force more posts to load ---
let scanning = false;

// Try to read the post total declared in the profile header ("9 posts",
// "9 publicações", ...) so we know when everything has been found and can
// stop early — without it the scroll never ends, because Instagram queues
// suggestions from other profiles forever once the owner's posts run out.
// The regex keeps the Portuguese wording too, since it matches whatever
// language Instagram renders its UI in.
function getDeclaredPostCount() {
  const text = document.body.innerText || "";
  const match = text.match(/([\d.,]+)\s*(posts?|publica[cç][aã]o|publica[cç][oõ]es)/i);
  if (!match) return null;
  const n = parseInt(match[1].replace(/[.,]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function countPostLinks() {
  return document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').length;
}

async function autoScroll({ maxRounds = 20, maxIdleRounds = 2, stepDelayMs = 1500, targetCount = null } = {}) {
  let lastHeight = 0;
  let lastLinkCount = -1;
  let idleRounds = 0;
  let round = 0;

  while (round < maxRounds) {
    if (!scanning) return; // cancelled
    round++;

    const linkCount = countPostLinks();
    if (targetCount && linkCount >= targetCount) return;

    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, stepDelayMs));

    const newHeight = document.body.scrollHeight;
    const newLinkCount = countPostLinks();

    if (newLinkCount === lastLinkCount && newHeight <= lastHeight) {
      idleRounds++;
      if (idleRounds >= maxIdleRounds) return;
    } else {
      idleRounds = 0;
    }
    lastHeight = newHeight;
    lastLinkCount = newLinkCount;
  }
}

function findReelsTabLink() {
  const links = Array.from(document.querySelectorAll('a[href*="/reels/"]'));
  return links.find((a) => {
    const href = a.getAttribute("href") || "";
    return /^\/[^/]+\/reels\/?$/.test(href);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getPostLinks() {
  const anchors = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
  const seen = new Set();
  const unique = [];
  for (const a of anchors) {
    const href = a.getAttribute("href") || "";
    if (!href || seen.has(href)) continue;
    seen.add(href);
    unique.push(a);
  }
  return unique;
}

function updateAllowedFromDom() {
  if (!allowedShortcodes) return;
  for (const link of getPostLinks()) {
    const sc = shortcodeFromHref(link.getAttribute("href"));
    if (sc) allowedShortcodes.add(sc);
  }
}

function closeModal() {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true })
  );
}

// The initial HTML (after the refresh) only carries full data for the first
// ~12 posts; the rest, loaded by scrolling, only have a thumbnail and counter.
// For those the post has to be opened (click -> wait -> close) to make
// Instagram fetch the real video URL, exactly as it would if you clicked each
// one by hand.
async function visitPostsForVideoData(links, visitedHrefs) {
  let i = 0;
  for (const link of links) {
    if (!scanning) return;
    const href = link.getAttribute("href") || "";
    if (!href || visitedHrefs.has(href)) continue;
    visitedHrefs.add(href);
    i++;

    safeSend({
      type: "SCAN_STATUS",
      status: "opening-post",
      detail: `${i}/${links.length}`,
    });

    try {
      link.scrollIntoView({ block: "center" });
      link.click();
    } catch (e) {
      continue;
    }
    await sleep(1500);
    scanJsonScriptTags();
    closeModal();
    await sleep(500);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_SCAN") {
    scanning = true;
    allowedShortcodes = new Set();
    videoLimit = msg.limit || null;
    foundCount = 0;
    reportedKeys.clear();
    const visitedHrefs = new Set();
    (async () => {
      try {
        updateAllowedFromDom();
        scanJsonScriptTags();
        const targetCount = getDeclaredPostCount();

        safeSend({ type: "SCAN_STATUS", status: "scanning-posts" });
        await autoScroll({ targetCount });

        if (scanning) {
          updateAllowedFromDom();
          await visitPostsForVideoData(getPostLinks(), visitedHrefs);
        }

        if (scanning) {
          const reelsLink = findReelsTabLink();
          if (reelsLink) {
            safeSend({ type: "SCAN_STATUS", status: "opening-reels" });
            reelsLink.click();
            await sleep(2000);
            updateAllowedFromDom();
            scanJsonScriptTags();
            safeSend({ type: "SCAN_STATUS", status: "scanning-reels" });
            await autoScroll();

            if (scanning) {
              updateAllowedFromDom();
              await visitPostsForVideoData(getPostLinks(), visitedHrefs);
            }
          }
        }
      } catch (e) {
        console.warn("IG video grabber: error during the scan", e);
      } finally {
        // makes sure the panel never stays stuck even if something throws
        scanning = false;
        safeSend({ type: "SCAN_STATUS", status: "done" });
      }
    })();
    sendResponse({ ok: true });
  } else if (msg.type === "STOP_SCAN") {
    scanning = false;
    sendResponse({ ok: true });
  } else if (msg.type === "FETCH_VIDEO_BYTES") {
    // Fetching the video here (running on the Instagram page itself) instead of
    // in the extension panel avoids CORS blocks: the CDN generally only allows
    // reads via fetch/XHR from the instagram.com origin.
    (async () => {
      try {
        const res = await fetch(msg.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        sendResponse({ ok: true, base64: btoa(binary) });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  return true;
});
