#!/usr/bin/env bash
set -e

npm install

# Ensure Puppeteer's downloaded Chrome persists between builds
if [ ! -d "$PUPPETEER_CACHE_DIR" ] ; then
  echo "Copying Puppeteer cache from build cache..."
  cp -R "$XDG_CACHE_HOME/puppeteer" "$PUPPETEER_CACHE_DIR" || true
else
  echo "Storing Puppeteer cache to build cache..."
  cp -R "$PUPPETEER_CACHE_DIR" "$XDG_CACHE_HOME/puppeteer" || true
fi 