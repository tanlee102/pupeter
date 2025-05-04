import { NextResponse } from "next/server";
import puppeteer from "puppeteer";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  let page;
  let videoUrls = null;
  let found = false;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (req) => req.continue());

    page.on("response", async (response) => {
      try {
        const responseUrl = response.url();
        if (
          responseUrl.includes(
            "https://www.douyin.com/aweme/v1/web/aweme/detail/"
          )
        ) {
          const data = await response.json();
          if (
            data.aweme_detail &&
            data.aweme_detail.video &&
            Array.isArray(data.aweme_detail.video.bit_rate)
          ) {
            // Lấy tất cả url_list của các candidate video
            videoUrls = data.aweme_detail.video.bit_rate
              .map((v) =>
                v.play_addr && v.play_addr.url_list ? v.play_addr.url_list : []
              )
              .flat();
            found = videoUrls.length > 0;
          }
        }
      } catch (err) {
        // ignore
      }
    });

    let url = urlToVisit;
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }
    await page.goto(url, { timeout: 150000 });
    // Đợi tối đa 10s hoặc đến khi tìm thấy videoUrls
    const maxWait = 10000;
    const poll = 200;
    let waited = 0;
    while (!found && waited < maxWait) {
      await new Promise((r) => setTimeout(r, poll));
      waited += poll;
    }
    await page.close();
    await browser.close();
    if (videoUrls && videoUrls.length > 0) {
      return NextResponse.json({ videoUrls });
    } else {
      return NextResponse.json(
        { message: "No matching video URLs found." },
        { status: 404 }
      );
    }
  } catch (error) {
    if (page)
      try {
        await page.close();
      } catch {}
    if (browser)
      try {
        await browser.close();
      } catch {}
    console.error("Douyin video url extraction error:", error);
    return NextResponse.json(
      { message: "Error processing Douyin URL" },
      { status: 500 }
    );
  }
}
