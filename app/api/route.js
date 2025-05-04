import { NextResponse } from "next/server";
import puppeteer from "puppeteer";
export const dynamic = "force-dynamic";
export const maxDuration = 100;

// Semaphore để giới hạn số page mở đồng thời (ví dụ: 3)
const MAX_CONCURRENT_PAGES = 3;
let currentPages = 0;
const pageQueue = [];

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserPromise;
}

async function acquirePage() {
  if (currentPages < MAX_CONCURRENT_PAGES) {
    currentPages++;
    return;
  }
  return new Promise((resolve) => pageQueue.push(resolve));
}

function releasePage() {
  currentPages--;
  if (pageQueue.length > 0) {
    currentPages++;
    const next = pageQueue.shift();
    next();
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const urlToVisit = searchParams.get("url");

  if (!urlToVisit) {
    return NextResponse.json(
      { message: "Missing URL parameter" },
      { status: 400 }
    );
  }

  await acquirePage();
  let browser;
  let page;
  let foundData = null;
  let responsePromiseResolve;
  const responsePromise = new Promise((resolve) => {
    responsePromiseResolve = resolve;
  });

  try {
    browser = await getBrowser();
    page = await browser.newPage();

    // Block images, stylesheets, fonts, media to save bandwidth and speed up
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      if (["image", "stylesheet", "font", "media"].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 500, height: 300 });
    await page.setCacheEnabled(false);

    let url = urlToVisit;
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }

    // Listen for the first aweme detail response only
    page.on("response", async (response) => {
      try {
        const responseUrl = response.url();
        if (
          responseUrl.includes(
            "https://www.douyin.com/aweme/v1/web/aweme/detail/"
          ) &&
          !foundData
        ) {
          foundData = await response.json();
          responsePromiseResolve(); // resolve ngay khi có data
        }
      } catch (err) {}
    });

    // Promise race: chờ response hoặc timeout tổng thể 95s
    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 95000));

    await Promise.race([
      (async () => {
        try {
          await page.goto(url, {
            timeout: 90000,
            waitUntil: "domcontentloaded",
          });
        } catch (err) {}
        await responsePromise;
      })(),
      timeoutPromise,
    ]);

    await page.close();
    releasePage();

    if (foundData) {
      return NextResponse.json(foundData);
    } else {
      return NextResponse.json(
        { message: "Không tìm thấy dữ liệu phù hợp hoặc timeout" },
        { status: 404 }
      );
    }
  } catch (error) {
    if (page) await page.close();
    releasePage();
    return NextResponse.json(
      { message: "Error fetching data" },
      { status: 500 }
    );
  }
}
