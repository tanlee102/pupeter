const { join } = require("path");
/** @type {import('puppeteer').Configuration} */
module.exports = {
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
  // Modern headless mode uses the regular Chrome for Testing binary. Avoid
  // downloading a second headless-shell binary into the Render image.
  "chrome-headless-shell": {
    skipDownload: true,
  },
};
