// Runs in the MAIN world (the page's real context), BEFORE the Instagram app
// loads. Hooks fetch/XHR to capture the JSON responses Instagram itself already
// requests while you scroll the profile/reels, and extracts any video found.
// This avoids having to reimplement Instagram's private API (headers, app-id,
// and so on), which changes often.

(function () {
  const SOURCE = "ig-video-grabber";

  function safeParseJSON(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

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

  function extractVideos(obj, results, seen, depth) {
    if (!obj || typeof obj !== "object" || depth > 12) return;

    if (Array.isArray(obj)) {
      for (const item of obj) extractVideos(item, results, seen, depth + 1);
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
        extractVideos(obj[k], results, seen, depth + 1);
      }
    }
  }

  function reportIfAny(data) {
    if (!data) return;
    const results = [];
    const seen = new Set();
    extractVideos(data, results, seen, 0);
    if (results.length > 0) {
      window.postMessage({ source: SOURCE, videos: results }, "*");
    }
  }

  // --- Hook fetch ---
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    p.then((res) => {
      try {
        res
          .clone()
          .text()
          .then((text) => reportIfAny(safeParseJSON(text)))
          .catch(() => {});
      } catch (e) {
        /* ignore */
      }
    }).catch(() => {});
    return p;
  };

  // --- Hook XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ig_grabber_url = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        if (typeof this.responseText === "string") {
          reportIfAny(safeParseJSON(this.responseText));
        }
      } catch (e) {
        /* ignore */
      }
    });
    return origSend.apply(this, args);
  };
})();
