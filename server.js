import { createServer } from "node:http";
import puppeteer from "puppeteer";

const HOST = "0.0.0.0";
const PORT = readBoundedInteger("PORT", 3000, 1, 65_535);
const DETAIL_PATH = "/aweme/v1/web/aweme/detail/";
const PAGE_TIMEOUT_MS = 55_000;
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
    pixels: width * height,
    bitRate: Number(rate?.bit_rate) || 0,
    fps: Number(rate?.FPS) || 0,
    dataSize: Number(address.data_size) || 0,
    shortEdge: Math.min(width, height),
  };
}

function compareQuality(a, b) {
  return (
    b.pixels - a.pixels ||
    b.bitRate - a.bitRate ||
    b.fps - a.fps ||
    b.dataSize - a.dataSize
  );
}

function selectBestVideo(video, isFHD) {
  const variants = (Array.isArray(video?.bit_rate) ? video.bit_rate : [])
    .map(toVariant)
    .filter(Boolean);

  for (const address of [
    video?.play_addr,
    video?.play_addr_h264,
    video?.play_addr_265,
  ]) {
    const variant = toVariant(address);
    if (variant) variants.push(variant);
  }

  if (variants.length === 0) return null;

  let eligible = variants;
  if (!isFHD) {
    const upTo1080p = variants.filter(({ shortEdge }) => shortEdge <= 1080);
    if (upTo1080p.length > 0) eligible = upTo1080p;
  }
  return eligible.sort(compareQuality)[0];
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

function responseIsAwemeDetail(response) {
  try {
    return new URL(response.url()).pathname === DETAIL_PATH;
  } catch {
    return false;
  }
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

    const detailResponsePromise = page
      .waitForResponse(responseIsAwemeDetail, { timeout: PAGE_TIMEOUT_MS })
      .then(
        (response) => ({ response }),
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
    if (!detailResult.response) {
      const navigationResult = await navigationPromise;
      throw (
        detailResult.error ??
        navigationResult.error ??
        new Error("No detail response")
      );
    }

    const payload = await detailResult.response.json();
    const detail = payload?.aweme_detail;
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

    if (request.method !== "GET") {
      sendJson(response, 405, { message: "Method not allowed" }, { Allow: "GET" });
      return;
    }
    if (url.pathname === "/api/health") {
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

server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

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
