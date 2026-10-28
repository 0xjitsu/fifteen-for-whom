#!/usr/bin/env bash
# Verify the link-preview video on a deployed URL.
# Usage: scripts/check-live.sh https://fifteen-for-whom.vercel.app
set -euo pipefail

BASE="${1:?usage: check-live.sh <base-url>}"
BASE="${BASE%/}"
MAX=$((5 * 1024 * 1024))
fail=0

headers=$(curl -sS -L -o /dev/null -D - -A 'check-live/1.0' "$BASE/og/preview.mp4")
status=$(printf '%s' "$headers" | grep -i '^HTTP/' | tail -1 | awk '{print $2}')
ctype=$(printf '%s' "$headers" | grep -i '^content-type:' | tail -1 | tr -d '\r' | awk '{print tolower($2)}')
size=$(curl -sS -L -o /dev/null -w '%{size_download}' -A 'check-live/1.0' "$BASE/og/preview.mp4")

echo "status=$status content-type=$ctype bytes=$size"
[ "$status" = "200" ] || { echo "FAIL: expected HTTP 200"; fail=1; }
case "$ctype" in video/mp4*) ;; *) echo "FAIL: expected content-type video/mp4"; fail=1 ;; esac
[ "$size" -gt 0 ] && [ "$size" -lt "$MAX" ] || { echo "FAIL: size must be >0 and < $MAX bytes"; fail=1; }

# tags on the live page
page=$(curl -sS -L -A 'check-live/1.0' "$BASE/")
for t in 'og:video' 'og:video:secure_url' 'og:video:type' 'og:video:width' 'og:video:height' 'twitter:card' 'twitter:player' 'twitter:player:width' 'twitter:player:height' 'og:image'; do
  printf '%s' "$page" | grep -q "\"$t\"" || { echo "FAIL: missing tag $t"; fail=1; }
done
pstatus=$(curl -sS -L -o /dev/null -w '%{http_code}' -A 'check-live/1.0' "$BASE/og/player.html")
[ "$pstatus" = "200" ] || { echo "FAIL: /og/player.html returned $pstatus"; fail=1; }

[ "$fail" = 0 ] && echo "OK: $BASE link preview checks passed"
exit "$fail"
