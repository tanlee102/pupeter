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

  try {
    let browser;

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();

    let url = urlToVisit;
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }

    await page.goto(url, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "20px",
        right: "10px",
        bottom: "10px",
        left: "20px",
      },
    });

    await browser.close();

    return new NextResponse(pdf, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename=webpage.pdf`,
      },
    });
  } catch (error) {
    console.error("PDF generation error:", error);
    return NextResponse.json(
      { message: "Error generating PDF" },
      { status: 500 }
    );
  }
}
