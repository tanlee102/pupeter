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
  const mode = searchParams.get("mode");
  const isFHD = mode === "FHD";

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
          const data = await response.json();
          if (data && data.aweme_detail) {
            const detail = data.aweme_detail;
            let accountName = null;
            let thumbnailUrl = null;
            let selectedVideoUrl = null;

            // Lấy tên account
            if (detail.author && detail.author.nickname) {
              accountName = detail.author.nickname.replace(
                /[<>:"/\\|?*]+/g,
                "_"
              );
            }
            // Lấy thumbnail
            if (
              detail.video &&
              detail.video.cover &&
              detail.video.cover.url_list &&
              detail.video.cover.url_list.length > 0
            ) {
              thumbnailUrl = detail.video.cover.url_list[0];
            }
            // Chọn video
            const bitRateData =
              detail.video && detail.video.bit_rate
                ? detail.video.bit_rate
                : null;
            if (bitRateData && Array.isArray(bitRateData)) {
              let candidate = null;
              if (isFHD) {
                // Ưu tiên chọn video >= 1120
                let candidates1120 = bitRateData.filter((video) => {
                  const play_addr = video.play_addr;
                  return (
                    play_addr &&
                    play_addr.width >= 1120 &&
                    play_addr.height >= 1120 &&
                    play_addr.data_size
                  );
                });
                if (candidates1120.length > 0) {
                  candidate = candidates1120.reduce((min, v) =>
                    v.play_addr.data_size < min.play_addr.data_size ? v : min
                  );
                }
              }
              if (!candidate) {
                // Ưu tiên chọn video >= 1080
                let candidates1080 = bitRateData.filter((video) => {
                  const play_addr = video.play_addr;
                  return (
                    play_addr &&
                    play_addr.width >= 1080 &&
                    play_addr.height >= 1080 &&
                    play_addr.data_size
                  );
                });
                if (candidates1080.length > 0) {
                  candidate = candidates1080.reduce((min, v) =>
                    v.play_addr.data_size < min.play_addr.data_size ? v : min
                  );
                } else {
                  // Nếu không có video >= 1080, chọn video >= 720
                  let candidates720 = bitRateData.filter((video) => {
                    const play_addr = video.play_addr;
                    return (
                      play_addr &&
                      play_addr.width >= 720 &&
                      play_addr.height >= 720 &&
                      play_addr.data_size
                    );
                  });
                  if (candidates720.length > 0) {
                    candidate = candidates720.reduce((min, v) =>
                      v.play_addr.data_size < min.play_addr.data_size ? v : min
                    );
                  } else {
                    // Nếu không có video >= 720, chọn video >= 540
                    let candidates540 = bitRateData.filter((video) => {
                      const play_addr = video.play_addr;
                      return (
                        play_addr &&
                        play_addr.width >= 540 &&
                        play_addr.height >= 540 &&
                        play_addr.data_size
                      );
                    });
                    if (candidates540.length > 0) {
                      candidate = candidates540.reduce((min, v) =>
                        v.play_addr.data_size < min.play_addr.data_size
                          ? v
                          : min
                      );
                    }
                  }
                }
              }
              if (candidate) {
                selectedVideoUrl = candidate.play_addr.url_list[0];
              }
            }
            foundData = {
              video_url: selectedVideoUrl,
              thumbnail_url: thumbnailUrl,
              account_name: accountName,
            };
            responsePromiseResolve();
          }
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
