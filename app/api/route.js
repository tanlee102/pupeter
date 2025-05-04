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
  let selectedVideoUrl = null;
  let selectedBitrate = null;
  let awemeDetailJson = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();

    let url = urlToVisit;
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }

    // Listen for the aweme detail response
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
            data &&
            data.aweme_detail &&
            data.aweme_detail.video &&
            Array.isArray(data.aweme_detail.video.bit_rate)
          ) {
            // Chọn video có độ phân giải cao nhất (bit_rate lớn nhất)
            const bitRates = data.aweme_detail.video.bit_rate;
            let best = bitRates[0];
            for (let i = 1; i < bitRates.length; i++) {
              if (bitRates[i].bit_rate > best.bit_rate) {
                best = bitRates[i];
              }
            }
            if (
              best &&
              best.play_addr &&
              Array.isArray(best.play_addr.url_list) &&
              best.play_addr.url_list.length > 0
            ) {
              selectedVideoUrl = best.play_addr.url_list[0];
              selectedBitrate = best.bit_rate;
              awemeDetailJson = data.aweme_detail;
            }
          }
        }
      } catch (err) {
        // Ignore JSON parse errors for non-JSON responses
      }
    });

    try {
      await page.goto(url, { timeout: 150000 });
    } catch (err) {
      console.error("Lỗi tải trang:", err.message);
    }

    // Đợi tối đa 10s để response được bắt
    const waitForVideoUrl = async () => {
      for (let i = 0; i < 100; i++) {
        if (selectedVideoUrl) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    await waitForVideoUrl();

    await browser.close();

    if (selectedVideoUrl) {
      return NextResponse.json({
        video_url: selectedVideoUrl,
        bitrate: selectedBitrate,
        aweme_detail: awemeDetailJson,
      });
    } else {
      return NextResponse.json(
        { message: "Không tìm thấy video url phù hợp" },
        { status: 404 }
      );
    }
  } catch (error) {
    if (browser) await browser.close();
    console.error("PDF generation error:", error);
    return NextResponse.json(
      { message: "Error generating video url" },
      { status: 500 }
    );
  }
}
