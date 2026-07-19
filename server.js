import { createServer } from "node:http";
import puppeteer from "puppeteer";

const HOST = "0.0.0.0";
const PORT = readBoundedInteger("PORT", 3000, 1, 65_535);
const DETAIL_PATH = "/aweme/v1/web/aweme/detail/";
const PAGE_TIMEOUT_MS = readBoundedInteger(
  "DOUYIN_TIMEOUT_MS",
  180_000,
  10_000,
  300_000
);
const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const MAX_CONCURRENT_PAGES = readBoundedInteger(
  "MAX_CONCURRENT_PAGES",
  2,
  1,
  10
);
const MAX_QUEUE_LENGTH = readBoundedInteger("MAX_QUEUE_LENGTH", 20, 0, 100);
const QUEUE_TIMEOUT_MS = readBoundedInteger(
  "QUEUE_TIMEOUT_MS",
  45_000,
  1_000,
  PAGE_TIMEOUT_MS
);
const BLOCKED_RESOURCE_TYPES = new Set([
  "image",
  "stylesheet",
  "font",
  "media",
]);
const INSTAGRAM_PAGE_TIMEOUT_MS = readBoundedInteger(
  "INSTAGRAM_TIMEOUT_MS",
  90_000,
  5_000,
  180_000
);
const INSTAGRAM_CACHE_TTL_MS = 60 * 1000;
const INSTAGRAM_DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const INSTAGRAM_PAGE_HEADER_NAMES = new Set([
  "accept",
  "accept-language",
  "cookie",
  "referer",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "user-agent",
  "x-asbd-id",
  "x-csrftoken",
  "x-ig-app-id",
  "x-ig-www-claim",
  "x-requested-with",
]);

let activePages = 0;
let browserPromise = null;
let browserReady = false;
let browserWarmupPromise = null;
let shuttingDown = false;
const pageQueue = [];
const responseCache = new Map();
const inFlightRequests = new Map();

class CapacityError extends Error {
  constructor(message) {
    super(message);
    this.name = "CapacityError";
  }
}

function readBoundedInteger(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value)
    ? Math.min(Math.max(value, minimum), maximum)
    : fallback;
}

function sendJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(payload);
}

function getCachedResponse(key) {
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return null;
  }

  responseCache.delete(key);
  responseCache.set(key, cached);
  return cached.body;
}

function cacheResponse(key, body, ttlMs) {
  responseCache.set(key, { body, expiresAt: Date.now() + ttlMs });
  while (responseCache.size > MAX_CACHE_ENTRIES) {
    responseCache.delete(responseCache.keys().next().value);
  }
}

function getSafeCacheTtl(videoUrl) {
  try {
    const expirySegment = new URL(videoUrl).pathname.split("/").filter(Boolean)[0];
    if (!/^[0-9a-f]{8}$/i.test(expirySegment)) return CACHE_TTL_MS;

    const expiresAt = Number.parseInt(expirySegment, 16) * 1000;
    const safeTtl = expiresAt - Date.now() - CACHE_EXPIRY_MARGIN_MS;
    if (safeTtl <= 0) return CACHE_TTL_MS;
    return Math.min(Math.max(safeTtl, CACHE_TTL_MS), MAX_CACHE_TTL_MS);
  } catch {
    return CACHE_TTL_MS;
  }
}

async function getBrowser() {
  if (browserPromise) return browserPromise;

  const launchPromise = puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-breakpad",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-first-run",
    ],
  });
  browserPromise = launchPromise;

  try {
    const browser = await launchPromise;
    browser.once("disconnected", () => {
      if (browserPromise === launchPromise) browserPromise = null;
      browserReady = false;
      if (!shuttingDown) scheduleBrowserWarmup();
    });
    return browser;
  } catch (error) {
    if (browserPromise === launchPromise) browserPromise = null;
    throw error;
  }
}

async function closeBrowser() {
  const pendingBrowser = browserPromise;
  browserPromise = null;
  browserReady = false;
  if (!pendingBrowser) return;

  try {
    const browser = await pendingBrowser;
    await browser.close();
  } catch {
    // The browser may already have exited during container shutdown.
  }
}

async function configurePage(page, timeoutMs = PAGE_TIMEOUT_MS) {
  page.setDefaultNavigationTimeout(timeoutMs);
  page.setDefaultTimeout(timeoutMs);
  await page.setBypassServiceWorker(true);
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  });
  await page.setCacheEnabled(true);
  await page.setRequestInterception(true);
  page.on("request", (interceptedRequest) => {
    const action = BLOCKED_RESOURCE_TYPES.has(interceptedRequest.resourceType())
      ? interceptedRequest.abort()
      : interceptedRequest.continue();
    action.catch(() => {});
  });
}

function scheduleBrowserWarmup(delayMs = 1_000) {
  const timer = setTimeout(() => prewarmBrowser(), delayMs);
  timer.unref();
}

function prewarmBrowser() {
  if (browserWarmupPromise || shuttingDown) return browserWarmupPromise;

  browserWarmupPromise = (async () => {
    let page = null;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      await configurePage(page, 20_000);
      await page
        .goto("https://www.douyin.com/", {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        })
        .catch(() => {});
      browserReady = true;
      console.log("Chrome and Douyin session are warm");
    } catch (error) {
      browserReady = false;
      console.error("[browser] Warmup failed:", error);
      if (!shuttingDown) scheduleBrowserWarmup(5_000);
    } finally {
      if (page && !page.isClosed()) await page.close().catch(() => {});
      browserWarmupPromise = null;
    }
  })();

  return browserWarmupPromise;
}

async function acquirePageSlot() {
  if (activePages < MAX_CONCURRENT_PAGES) {
    activePages += 1;
  } else {
    if (pageQueue.length >= MAX_QUEUE_LENGTH) {
      throw new CapacityError("Douyin worker queue is full");
    }

    await new Promise((resolve, reject) => {
      const queuedRequest = {
        resolve: () => {
          clearTimeout(queuedRequest.timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(queuedRequest.timer);
          reject(error);
        },
        timer: null,
      };
      queuedRequest.timer = setTimeout(() => {
        const index = pageQueue.indexOf(queuedRequest);
        if (index !== -1) pageQueue.splice(index, 1);
        queuedRequest.reject(
          new CapacityError("Timed out waiting for a Douyin worker")
        );
      }, QUEUE_TIMEOUT_MS);
      pageQueue.push(queuedRequest);
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;

    activePages -= 1;
    const next = pageQueue.shift();
    if (next) {
      activePages += 1;
      next.resolve();
    }
  };
}

function getUrls(address) {
  if (!Array.isArray(address?.url_list)) return [];
  return [
    ...new Set(
      address.url_list
        .filter((url) => typeof url === "string" && url.length > 0)
        .map((url) =>
          url.startsWith("http://") ? `https://${url.slice(7)}` : url
        )
        .filter((url) => url.startsWith("https://"))
    ),
  ];
}

function firstHttpsUrl(address) {
  return getUrls(address)[0] ?? null;
}

function toVariant(rate) {
  const address = rate?.play_addr ?? rate;
  const url = firstHttpsUrl(address);
  if (!url) return null;

  const width = Number(address.width) || 0;
  const height = Number(address.height) || 0;
  return {
    url,
    width,
    height,
    dataSize: Number(address.data_size) || 0,
  };
}

function selectSmallestVariantAtLeast(variants, minimumDimension) {
  return (
    variants
      .filter(
        ({ width, height, dataSize }) =>
          width >= minimumDimension &&
          height >= minimumDimension &&
          dataSize > 0
      )
      .sort((a, b) => a.dataSize - b.dataSize)[0] ?? null
  );
}

function selectBestVideo(video, isFHD) {
  const variants = (Array.isArray(video?.bit_rate) ? video.bit_rate : [])
    .map(toVariant)
    .filter(Boolean);

  if (isFHD) {
    const fhdVariant = selectSmallestVariantAtLeast(variants, 1120);
    if (fhdVariant) return fhdVariant;
  }

  for (const minimumDimension of [1080, 720, 540]) {
    const variant = selectSmallestVariantAtLeast(variants, minimumDimension);
    if (variant) return variant;
  }

  return null;
}

function isFHDRequest(searchParams) {
  if (searchParams.get("mode")?.toUpperCase() === "FHD") return true;
  if (searchParams.get("quality")?.toUpperCase() === "FHD") return true;
  return ["1", "true", "yes", "on"].includes(
    searchParams.get("fhd")?.toLowerCase()
  );
}

function sanitizeAccountName(name) {
  if (typeof name !== "string") return null;
  return name.replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "_").trim() || null;
}

function decodeHtmlText(value = "") {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function decodeInstagramEscapes(value = "") {
  return decodeHtmlText(value)
    .replace(/\\u003C/g, "<")
    .replace(/\\u003E/g, ">")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/");
}

function walkJson(value, visit, path = []) {
  if (!value || typeof value !== "object") return;
  visit(value, path);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walkJson(value[index], visit, path.concat(index));
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    walkJson(child, visit, path.concat(key));
  }
}

function parseXmlAttributes(source = "") {
  const attributes = {};
  for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    attributes[match[1]] = decodeHtmlText(match[2]);
  }
  return attributes;
}

function parseInstagramDashManifest(manifest) {
  const xml = decodeInstagramEscapes(manifest);
  const representations = [];
  const adaptationSetPattern =
    /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g;
  let adaptationSetMatch;

  while ((adaptationSetMatch = adaptationSetPattern.exec(xml))) {
    const adaptationSet = parseXmlAttributes(adaptationSetMatch[1]);
    const representationPattern =
      /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g;
    let representationMatch;

    while ((representationMatch = representationPattern.exec(adaptationSetMatch[2]))) {
      const representation = parseXmlAttributes(representationMatch[1]);
      const baseUrl = representationMatch[2]
        .match(/<BaseURL>([\s\S]*?)<\/BaseURL>/)?.[1]
        ?.trim();

      if (!baseUrl) continue;
      representations.push({
        ...adaptationSet,
        ...representation,
        contentType:
          adaptationSet.contentType ||
          representation.contentType ||
          adaptationSet.mimeType ||
          representation.mimeType ||
          "",
        url: decodeInstagramEscapes(baseUrl),
      });
    }
  }

  return representations;
}

function parseQualityLabel(label) {
  const match = String(label || "").match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function representationScore(representation) {
  const width = Number.parseInt(representation.width || "0", 10) || 0;
  const height = Number.parseInt(representation.height || "0", 10) || 0;
  const bandwidth = Number.parseInt(representation.bandwidth || "0", 10) || 0;
  return {
    pixels: width * height,
    quality: parseQualityLabel(representation.FBQualityLabel),
    bandwidth,
  };
}

function compareVideoRepresentations(left, right) {
  const leftScore = representationScore(left);
  const rightScore = representationScore(right);
  return (
    rightScore.pixels - leftScore.pixels ||
    rightScore.quality - leftScore.quality ||
    rightScore.bandwidth - leftScore.bandwidth
  );
}

function selectBestInstagramVideo(representations) {
  return (
    representations
      .filter((representation) => {
        const contentType = String(representation.contentType || "").toLowerCase();
        const mimeType = String(representation.mimeType || "").toLowerCase();
        return contentType.includes("video") || mimeType.includes("video");
      })
      .sort(compareVideoRepresentations)[0] ?? null
  );
}

function selectBestInstagramAudio(representations) {
  return (
    representations
      .filter((representation) => {
        const contentType = String(representation.contentType || "").toLowerCase();
        const mimeType = String(representation.mimeType || "").toLowerCase();
        return contentType.includes("audio") || mimeType.includes("audio");
      })
      .sort(
        (left, right) =>
          (Number.parseInt(right.bandwidth || "0", 10) || 0) -
          (Number.parseInt(left.bandwidth || "0", 10) || 0)
      )[0] ?? null
  );
}

function selectBestInstagramVersion(versions = []) {
  return (
    versions
      .filter((version) => typeof version?.url === "string" && version.url)
      .sort((left, right) => {
        const leftPixels = (Number(left.width) || 0) * (Number(left.height) || 0);
        const rightPixels = (Number(right.width) || 0) * (Number(right.height) || 0);
        return rightPixels - leftPixels;
      })[0] ?? null
  );
}

function selectBestThumbnail(media) {
  const candidates = Array.isArray(media?.image_versions2?.candidates)
    ? media.image_versions2.candidates
    : [];
  const selected = candidates
    .filter((candidate) => typeof candidate?.url === "string" && candidate.url)
    .sort((left, right) => {
      const leftPixels = (Number(left.width) || 0) * (Number(left.height) || 0);
      const rightPixels = (Number(right.width) || 0) * (Number(right.height) || 0);
      return rightPixels - leftPixels;
    })[0];

  return (
    selected?.url ||
    media?.thumbnail_src ||
    media?.display_url ||
    media?.image_versions2?.additional_candidates?.first_frame?.url ||
    null
  );
}

function getInstagramShortcode(rawUrl, explicitShortcode) {
  const shortcode = explicitShortcode?.trim();
  if (shortcode && /^[A-Za-z0-9_-]{5,40}$/.test(shortcode)) return shortcode;

  try {
    const parsed = new URL(rawUrl);
    const match = parsed.pathname.match(/\/(?:reel|reels|p|tv)\/([^/?#]+)/i);
    if (match?.[1] && /^[A-Za-z0-9_-]{5,40}$/.test(match[1])) {
      return match[1];
    }
  } catch {
    // The caller may pass a shortcode directly instead of a full URL.
  }

  if (rawUrl && /^[A-Za-z0-9_-]{5,40}$/.test(rawUrl.trim())) {
    return rawUrl.trim();
  }

  return null;
}

function buildInstagramReelUrl(shortcode) {
  return `https://www.instagram.com/reels/${encodeURIComponent(shortcode)}/`;
}

function cleanInstagramHeaders(headers = {}) {
  const cleaned = {
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://www.instagram.com/",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "user-agent": INSTAGRAM_DEFAULT_USER_AGENT,
  };

  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return cleaned;
  }

  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (!INSTAGRAM_PAGE_HEADER_NAMES.has(normalizedKey)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    cleaned[normalizedKey] = value;
  }

  return cleaned;
}

function getInstagramManifest(media) {
  return media?.dash_info?.video_dash_manifest || media?.video_dash_manifest || null;
}

function isMatchingInstagramMedia(media, shortcode) {
  return (
    (media?.code === shortcode || media?.shortcode === shortcode) &&
    (getInstagramManifest(media) || Array.isArray(media?.video_versions))
  );
}

function extractInstagramJsonScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => /type=["']application\/json["']/i.test(match[1]))
    .map((match) => decodeHtmlText(match[2].trim()))
    .filter(Boolean);
}

function extractInstagramMediaFromHtml(html, shortcode) {
  for (const script of extractInstagramJsonScripts(html)) {
    let parsed;
    try {
      parsed = JSON.parse(script);
    } catch {
      continue;
    }

    let matchedMedia = null;
    walkJson(parsed, (candidate) => {
      if (!matchedMedia && isMatchingInstagramMedia(candidate, shortcode)) {
        matchedMedia = candidate;
      }
    });

    if (matchedMedia) return matchedMedia;
  }

  return null;
}

function buildInstagramOwner(owner) {
  if (!owner) return null;
  return {
    id: owner.id || owner.pk || "",
    pk: owner.pk || owner.id || "",
    username: owner.username || "",
    full_name: owner.full_name || "",
    is_verified: Boolean(owner.is_verified),
  };
}

function buildInstagramMetadata(media, shortcode) {
  const owner = media.user || media.owner || media.caption?.user || null;
  const caption =
    typeof media.caption === "string" ? media.caption : media.caption?.text || "";
  const title = caption.split("\n").map((line) => line.trim()).find(Boolean) || "";
  const thumbnailUrl = selectBestThumbnail(media);
  const manifest = getInstagramManifest(media);
  const versions = Array.isArray(media.video_versions) ? media.video_versions : [];
  const ownerPayload = buildInstagramOwner(owner);
  const accountName =
    sanitizeAccountName(ownerPayload?.username || ownerPayload?.full_name) || "";

  if (manifest) {
    const representations = parseInstagramDashManifest(manifest);
    const video = selectBestInstagramVideo(representations);
    const audio = selectBestInstagramAudio(representations);

    if (!video?.url) {
      throw new Error("Instagram manifest did not include a playable video URL");
    }

    return {
      source: "instagram-html-dash",
      shortcode,
      id: media.pk || media.id || shortcode,
      media_id: media.id || "",
      title,
      caption,
      account_name: accountName,
      owner: ownerPayload,
      video_url: video.url,
      audio_url: audio?.url || null,
      thumbnail_url: thumbnailUrl,
      width: Number.parseInt(video.width || "0", 10) || media.original_width || null,
      height: Number.parseInt(video.height || "0", 10) || media.original_height || null,
      video_codec: video.codecs || "",
      audio_codec: audio?.codecs || "",
      has_audio_format: Boolean(audio?.url),
      requires_merge: Boolean(audio?.url),
      format_count: representations.length,
      quality_label: video.FBQualityLabel || "",
      video_bandwidth: Number.parseInt(video.bandwidth || "0", 10) || null,
      audio_bandwidth: Number.parseInt(audio?.bandwidth || "0", 10) || null,
      taken_at: media.taken_at || null,
      like_count: media.like_count ?? null,
      view_count: media.view_count ?? media.play_count ?? null,
    };
  }

  const version = selectBestInstagramVersion(versions);
  if (!version?.url) {
    throw new Error("Instagram page did not include a playable video URL");
  }

  return {
    source: "instagram-html-video_versions",
    shortcode,
    id: media.pk || media.id || shortcode,
    media_id: media.id || "",
    title,
    caption,
    account_name: accountName,
    owner: ownerPayload,
    video_url: version.url,
    audio_url: null,
    thumbnail_url: thumbnailUrl,
    width: Number(version.width) || media.original_width || null,
    height: Number(version.height) || media.original_height || null,
    video_codec: "",
    audio_codec: "",
    has_audio_format: true,
    requires_merge: false,
    format_count: versions.length,
    quality_label: "",
    video_bandwidth: null,
    audio_bandwidth: null,
    taken_at: media.taken_at || null,
    like_count: media.like_count ?? null,
    view_count: media.view_count ?? media.play_count ?? null,
  };
}

async function fetchTextWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return {
      response,
      text: await response.text(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonBody(request, limitBytes = 128 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new Error("Request body is too large");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) return {};
  return JSON.parse(body);
}

async function resolveInstagramVideo(request, searchParams) {
  const body = request.method === "POST" ? await readJsonBody(request) : {};
  const rawUrl = body.url || searchParams.get("url") || searchParams.get("shortcode");
  const shortcode = getInstagramShortcode(
    rawUrl,
    body.shortcode || searchParams.get("shortcode")
  );

  if (!shortcode) {
    return {
      status: 400,
      body: { message: "Missing or invalid Instagram reel shortcode" },
    };
  }

  const cacheKey = `instagram:${shortcode}`;
  const cached = getCachedResponse(cacheKey);
  if (cached) return { status: 200, body: cached };

  const pageUrl = buildInstagramReelUrl(shortcode);
  const headers = cleanInstagramHeaders(body.headers);

  try {
    const { response, text } = await fetchTextWithTimeout(
      pageUrl,
      { headers, redirect: "follow" },
      INSTAGRAM_PAGE_TIMEOUT_MS
    );

    if (!response.ok) {
      return {
        status: response.status,
        body: {
          message: `Instagram page returned ${response.status}`,
          shortcode,
        },
      };
    }

    const media = extractInstagramMediaFromHtml(text, shortcode);
    if (!media) {
      return {
        status: 404,
        body: {
          message: "Could not find matching Instagram media in page HTML",
          shortcode,
        },
      };
    }

    const bodyPayload = {
      ...buildInstagramMetadata(media, shortcode),
      page_url: pageUrl,
    };
    cacheResponse(cacheKey, bodyPayload, INSTAGRAM_CACHE_TTL_MS);
    return { status: 200, body: bodyPayload };
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    console.error(`[instagram] Failed to fetch reel ${shortcode}:`, error);
    return {
      status: timedOut ? 504 : 500,
      body: {
        message: timedOut
          ? "Instagram request timed out"
          : "Error fetching Instagram data",
        shortcode,
      },
    };
  }
}

function responseIsAwemeDetail(response) {
  try {
    return (
      response.request().method() === "GET" &&
      response.status() === 200 &&
      response.headers()["content-type"]?.includes("application/json") &&
      new URL(response.url()).pathname === DETAIL_PATH
    );
  } catch {
    return false;
  }
}

async function waitForAwemeDetail(page) {
  let payload = null;
  await page.waitForResponse(
    async (response) => {
      if (!responseIsAwemeDetail(response)) return false;

      try {
        const candidate = await response.json();
        if (!Object.hasOwn(candidate ?? {}, "aweme_detail")) return false;
        payload = candidate;
        return true;
      } catch {
        // Douyin can emit an empty response before retrying with valid JSON.
        return false;
      }
    },
    { timeout: PAGE_TIMEOUT_MS }
  );
  return payload;
}

async function resolveDouyinVideo(searchParams) {
  const id = searchParams.get("id")?.trim();
  if (!id) return { status: 400, body: { message: "Missing id parameter" } };
  if (!/^\d{10,30}$/.test(id)) {
    return { status: 400, body: { message: "Invalid Douyin video id" } };
  }

  const isFHD = isFHDRequest(searchParams);
  const cacheKey = `${id}:${isFHD ? "best" : "standard"}`;
  const cached = getCachedResponse(cacheKey);
  if (cached) return { status: 200, body: cached };

  const existingRequest = inFlightRequests.get(cacheKey);
  if (existingRequest) return existingRequest;

  let resolveInFlight;
  const inFlightRequest = new Promise((resolve) => {
    resolveInFlight = resolve;
  });
  inFlightRequests.set(cacheKey, inFlightRequest);

  const finish = (result, shouldCache = false) => {
    if (shouldCache) {
      cacheResponse(
        cacheKey,
        result.body,
        getSafeCacheTtl(result.body.video_url)
      );
    }
    resolveInFlight(result);
    return result;
  };

  let releasePageSlot = null;
  let page = null;

  try {
    releasePageSlot = await acquirePageSlot();
    const browser = await getBrowser();
    page = await browser.newPage();
    await configurePage(page);

    const detailResponsePromise = waitForAwemeDetail(page)
      .then(
        (payload) => ({ payload }),
        (error) => ({ error })
      );
    const navigationPromise = page
      .goto(`https://www.douyin.com/video/${id}`, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT_MS,
      })
      .then(
        () => ({ error: null }),
        (error) => ({ error })
      );

    const detailResult = await detailResponsePromise;
    if (!detailResult.payload) {
      const navigationResult = await navigationPromise;
      throw (
        detailResult.error ??
        navigationResult.error ??
        new Error("No detail response")
      );
    }

    const detail = detailResult.payload.aweme_detail;
    if (!detail) {
      return finish({
        status: 404,
        body: { message: "Douyin video was not found" },
      });
    }

    const selected = selectBestVideo(detail.video, isFHD);
    if (!selected) {
      return finish({
        status: 404,
        body: { message: "No playable video stream was found" },
      });
    }

    const thumbnailAddress =
      detail.video?.cover ??
      detail.video?.origin_cover ??
      detail.video?.dynamic_cover;
    return finish(
      {
        status: 200,
        body: {
          video_url: selected.url,
          thumbnail_url: firstHttpsUrl(thumbnailAddress),
          account_name: sanitizeAccountName(detail.author?.nickname),
        },
      },
      true
    );
  } catch (error) {
    const timedOut = error?.name === "TimeoutError";
    const atCapacity = error instanceof CapacityError;
    if (!atCapacity) console.error(`[douyin] Failed to fetch video ${id}:`, error);
    return finish({
      status: atCapacity ? 503 : timedOut ? 504 : 500,
      body: {
        message: atCapacity
          ? "Douyin service is busy; retry shortly"
          : timedOut
            ? "Douyin request timed out"
            : "Error fetching data",
      },
    });
  } finally {
    if (page && !page.isClosed()) await page.close().catch(() => {});
    releasePageSlot?.();
    if (inFlightRequests.get(cacheKey) === inFlightRequest) {
      inFlightRequests.delete(cacheKey);
    }
  }
}

const server = createServer(async (request, response) => {
  const requestStartedAt = Date.now();
  try {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/api/health") {
      if (request.method !== "GET") {
        sendJson(response, 405, { message: "Method not allowed" }, { Allow: "GET" });
        return;
      }
      const healthy = browserReady && !shuttingDown;
      sendJson(response, healthy ? 200 : 503, {
        status: shuttingDown ? "stopping" : healthy ? "ok" : "starting",
      });
      return;
    }
    if (shuttingDown) {
      sendJson(response, 503, { message: "Service is restarting" });
      return;
    }

    if (url.pathname === "/api/instagram") {
      if (!["GET", "POST"].includes(request.method)) {
        sendJson(response, 405, { message: "Method not allowed" }, { Allow: "GET, POST" });
        return;
      }

      const result = await resolveInstagramVideo(request, url.searchParams);
      sendJson(
        response,
        result.status,
        result.body,
        result.status === 200
          ? { "Cache-Control": "private, max-age=30" }
          : undefined
      );
      console.log(
        `[http] ${request.method} /api/instagram ${result.status} ${
          Date.now() - requestStartedAt
        }ms`
      );
      return;
    }

    if (request.method !== "GET") {
      sendJson(response, 405, { message: "Method not allowed" }, { Allow: "GET" });
      return;
    }
    if (url.pathname !== "/api") {
      sendJson(response, 404, { message: "Not found" });
      return;
    }

    const result = await resolveDouyinVideo(url.searchParams);
    const cacheHeaders =
      result.status === 200
        ? {
            "Cache-Control":
              "public, max-age=60, s-maxage=120, stale-while-revalidate=30",
          }
        : result.status === 503
          ? { "Retry-After": "5" }
          : undefined;
    sendJson(
      response,
      result.status,
      result.body,
      cacheHeaders
    );
    console.log(
      `[http] GET /api ${result.status} ${Date.now() - requestStartedAt}ms`
    );
  } catch (error) {
    console.error("[http] Request failed:", error);
    if (!response.headersSent) sendJson(response, 500, { message: "Internal error" });
    else response.destroy();
  }
});

server.requestTimeout = PAGE_TIMEOUT_MS + QUEUE_TIMEOUT_MS + 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.setTimeout(PAGE_TIMEOUT_MS + QUEUE_TIMEOUT_MS + 30_000);

server.listen(PORT, HOST, () => {
  console.log(`Douyin API listening on http://${HOST}:${PORT}`);
  prewarmBrowser();
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; finishing active requests`);

  while (pageQueue.length > 0) {
    pageQueue
      .shift()
      .reject(new CapacityError("Service is restarting; retry shortly"));
  }

  const forceExit = setTimeout(() => process.exit(1), 65_000);
  forceExit.unref();
  server.close(async (error) => {
    await closeBrowser();
    clearTimeout(forceExit);
    process.exit(error ? 1 : 0);
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("uncaughtException", (error) => {
  console.error("[process] Uncaught exception:", error);
  shutdown("uncaughtException");
});
process.once("unhandledRejection", (reason) => {
  console.error("[process] Unhandled rejection:", reason);
  shutdown("unhandledRejection");
});
