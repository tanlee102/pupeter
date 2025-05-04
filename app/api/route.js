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
  let foundData = null;

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

    // Listen for the first aweme detail response only
    const responseHandler = async (response) => {
      try {
        const responseUrl = response.url();
        if (
          responseUrl.includes(
            "https://www.douyin.com/aweme/v1/web/aweme/detail/"
          ) &&
          !foundData
        ) {
          foundData = await response.json();
        }
      } catch (err) {
        // Ignore JSON parse errors for non-JSON responses
      }
    };
    page.on("response", responseHandler);

    try {
      await page.goto(url, { timeout: 150000 });
    } catch (err) {
      console.error("Lỗi tải trang:", err.message);
    }

    // Đợi tối đa 10s để response được bắt
    const waitForData = async () => {
      for (let i = 0; i < 100; i++) {
        if (foundData) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    await waitForData();

    await browser.close();

    if (foundData) {
      return NextResponse.json(foundData);
    } else {
      return NextResponse.json(
        { message: "Không tìm thấy dữ liệu phù hợp" },
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
