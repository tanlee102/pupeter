FROM node:22.22.0-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json puppeteer.config.cjs ./
RUN npm ci --omit=dev

FROM node:22.22.0-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      dumb-init \
      fonts-liberation \
      fonts-noto-cjk \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libexpat1 \
      libfontconfig1 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxcursor1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxi6 \
      libxkbcommon0 \
      libxrandr2 \
      libxrender1 \
      libxshmfence1 \
      libxss1 \
      libxtst6 \
      xdg-utils \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=10000 \
    PUPPETEER_CACHE_DIR=/app/.cache/puppeteer \
    XDG_CONFIG_HOME=/tmp/chromium \
    XDG_CACHE_HOME=/tmp/chromium

RUN groupadd --system --gid 1001 appgroup \
    && useradd --system --uid 1001 --gid appgroup --create-home appuser \
    && mkdir -p /app/.cache /tmp/chromium \
    && chown -R appuser:appgroup /app /tmp/chromium

COPY --from=dependencies --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=dependencies --chown=appuser:appgroup /app/.cache/puppeteer /app/.cache/puppeteer
COPY --chown=appuser:appgroup server.js ./server.js

USER appuser
EXPOSE 10000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
