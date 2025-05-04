import { NextResponse } from "next/server";
import puppeteer from "puppeteer";
export const dynamic = "force-dynamic";
export const maxDuration = 80;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const urlToVisit = searchParams.get("url");

  if (!urlToVisit) {
    return NextResponse.json(
      { message: "Missing URL parameter" },
      { status: 400 }
    );
  }

  let browser;
  let foundData = null;
  let responsePromiseResolve;
  const responsePromise = new Promise((resolve) => {
    responsePromiseResolve = resolve;
  });

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();

    // Block images, stylesheets, fonts to save bandwidth and speed up
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      if (["image", "stylesheet", "font"].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    let url = urlToVisit;
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }

    // Listen for the first aweme detail response only
    page.on("response", async (response) => {
      try {
        const responseUrl = response.url();
        console.log(responseUrl);
        if (
          responseUrl.includes(
            "https://www.douyin.com/aweme/v1/web/aweme/detail/"
          ) &&
          !foundData
        ) {
          foundData = await response.json();
          responsePromiseResolve(); // resolve ngay khi có data
        }
      } catch (err) {
        // Ignore JSON parse errors for non-JSON responses
      }
    });

    // Promise race: chờ response hoặc timeout tổng thể 80s
    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 80000));

    await Promise.race([
      (async () => {
        try {
          await page.goto(url, {
            timeout: 70000,
            waitUntil: "domcontentloaded",
          });
        } catch (err) {
          // Có thể timeout, không sao
        }
        await responsePromise;
      })(),
      timeoutPromise,
    ]);

    await browser.close();

    if (foundData) {
      return NextResponse.json(foundData);
    } else {
      return NextResponse.json(
        { message: "Không tìm thấy dữ liệu phù hợp hoặc timeout" },
        { status: 404 }
      );
    }
  } catch (error) {
    if (browser) await browser.close();
    console.error("Error:", error);
    return NextResponse.json(
      { message: "Error fetching data" },
      { status: 500 }
    );
  }
}
