# Social video metadata API

Resolve the best available Douyin video stream:

```text
GET /api?id=7659729940322057381&fhd=true
```

`fhd=true` (also accepted as `mode=FHD` or `quality=FHD`) uses the original
selection behavior: among bitrate variants whose width and height are both at
least 1120 pixels, it chooses the smallest file. If none qualifies, selection
falls back through the 1080, 720, and 540 pixel tiers.

The successful response format remains:

```json
{
  "video_url": "https://...",
  "thumbnail_url": "https://...",
  "account_name": "..."
}
```

Resolve Instagram reel metadata from page HTML/DASH without `yt-dlp`:

```text
POST /api/instagram
```

```json
{
  "url": "https://www.instagram.com/reel/SHORTCODE/",
  "headers": {
    "cookie": "...",
    "user-agent": "..."
  }
}
```

The Instagram response includes the matched `shortcode`, owner/account metadata,
`video_url`, `audio_url`, `thumbnail_url`, source dimensions, and codec hints.
Karana downloads the returned video/audio URLs, merges them with `ffmpeg`, then
validates that the final MP4 has an audio stream before upload.

Without FHD mode, selection starts at the 1080 pixel tier, then falls back to
720 and 540, choosing the smallest qualifying file at each tier. Successful
results are cached in each server instance for at least two minutes and up to
15 minutes when the CDN URL exposes a safe expiry window. Concurrent requests
for the same video share one browser lookup.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Call [the local API](http://localhost:3000/api?id=7659729940322057381&fhd=true).

## Deploy on Render

Use the included `render.yaml` Blueprint. It deploys the service from the
multi-stage `Dockerfile` in Render's Singapore region, includes the Linux
libraries required by Chrome, runs as a non-root user, and checks
`/api/health` during deploys.

1. Push this repository to GitHub so the included production workflow runs.
2. In Render, choose **New > Blueprint** and select the repository.
3. Review the generated `douyin-video-api` web service and deploy it.

For a new service, Render defaults an omitted plan to Starter; an existing
service retains its current plan. Use an always-on paid instance for reliable
Puppeteer latency. A free instance can cold-start and has tighter memory
limits.

Automatic deploys run on each commit. Render builds the Docker image and only
routes traffic after `/api/health` confirms that Chrome is ready.

Render environment settings:

- `DOUYIN_TIMEOUT_MS=180000` allows a Douyin lookup to run for up to three minutes.
- `MAX_CONCURRENT_PAGES=2` limits Chrome memory usage.
- `MAX_QUEUE_LENGTH=20` rejects overload instead of exhausting memory.
- `QUEUE_TIMEOUT_MS=45000` prevents requests from waiting indefinitely.

The service is a plain Node.js HTTP server that binds to Render's `PORT` on
`0.0.0.0`. It prewarms Chrome and a lightweight Douyin session before the
health check reports ready, avoiding framework and first-browser-request
overhead.
