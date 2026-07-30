// Roda no "isolated world": recebe os vídeos capturados pelo content_main.js
// (via postMessage), encaminha para o background, e faz o auto-scroll do
// perfil/reels para forçar o Instagram a carregar mais posts.

const SOURCE = "ig-video-grabber";

function getUsernameFromUrl() {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "";
  const reserved = ["p", "reel", "reels", "stories", "explore", "direct", "accounts"];
  if (reserved.includes(parts[0])) return "";
  return parts[0];
}

// Enquanto um escaneamento está ativo, só aceitamos vídeos cujo shortcode
// apareceu no grid do próprio perfil (posts/reels que nós mesmos listamos).
// Isso evita capturar vídeos de "Sugestões"/"Para você" que o Instagram
// injeta no meio do feed, ou reels recomendados que tocam em sequência
// quando abrimos um reel do perfil.
let allowedShortcodes = null;

function shortcodeFromHref(href) {
  const m = (href || "").match(/\/(?:p|reel|reels)\/([^/?#]+)/);
  return m ? m[1] : null;
}

function filterAllowed(videos) {
  if (!allowedShortcodes || allowedShortcodes.size === 0) return videos;
  return videos.filter((v) => v.shortcode && allowedShortcodes.has(v.shortcode));
}

// chrome.runtime pode ficar inválido (ex: extensão recarregada enquanto a
// página continua aberta) — sem isso, um erro aqui derruba silenciosamente
// o resto do fluxo de escaneamento (fica "travado" para sempre).
function safeSend(msg) {
  try {
    chrome.runtime.sendMessage(msg);
  } catch (e) {
    /* contexto da extensão invalidado, ignora */
  }
}

// Limite opcional de vídeos escolhido pelo usuário: assim que atingido,
// paramos de escanear/abrir mais posts em vez de varrer o perfil inteiro.
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

// --- Escaneia dados já embutidos na página (perfis pequenos não fazem ---
// --- nenhuma requisição extra: os posts já vêm prontos no HTML inicial ---
// --- dentro de tags <script type="application/json">). ---

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
      /* não era JSON relevante, ignora */
    }
  }

  reportVideos(results);
}

// roda uma vez ao carregar, e observa novas tags <script> inseridas depois
// (ex: ao trocar de aba Posts/Reels dentro do perfil)
scanJsonScriptTags();
new MutationObserver(() => scanJsonScriptTags()).observe(document.documentElement, {
  childList: true,
  subtree: true,
});

// --- Auto-scroll para forçar carregamento de mais posts ---
let scanning = false;

// Tenta ler o total de posts declarado no cabeçalho do perfil ("9 posts",
// "9 publicações", etc) para saber quando já achamos tudo e parar cedo —
// sem isso, o scroll nunca para porque o Instagram enfileira sugestões de
// outros perfis infinitamente depois que os posts do dono acabam.
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
    if (!scanning) return; // cancelado
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

// O HTML inicial (após o F5) só vem com os dados completos dos primeiros
// ~12 posts; o resto, carregado via scroll, só tem miniatura/contador. Para
// esses, é preciso abrir o post (clique -> espera -> fecha) para forçar o
// Instagram a buscar a URL real do vídeo, do mesmo jeito que aconteceria se
// você clicasse manualmente em cada um.
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
        console.warn("IG video grabber: erro durante o escaneamento", e);
      } finally {
        // garante que o popup nunca fique "travado" mesmo se algo lançar erro
        scanning = false;
        safeSend({ type: "SCAN_STATUS", status: "done" });
      }
    })();
    sendResponse({ ok: true });
  } else if (msg.type === "STOP_SCAN") {
    scanning = false;
    sendResponse({ ok: true });
  } else if (msg.type === "FETCH_VIDEO_BYTES") {
    // Buscar o vídeo aqui (rodando na própria página do Instagram) em vez de
    // no painel da extensão evita bloqueios de CORS: o CDN costuma só
    // permitir leitura via fetch/XHR a partir da origem do instagram.com.
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
