#!/usr/bin/env bash
# Builds public/og-image.png (1200×630, the social card) with ImageMagick from the dashboard screenshot,
# echoing the hero: the title over a night sky and the dashboard rising out of a strip of grass.
# Needs `magick` (ImageMagick 7 with rsvg) and node_modules (for the fonts). Run from anywhere.
set -euo pipefail

SITE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$SITE/public/og-image.png"
SHOT="$SITE/public/screenshots/11-dashboard-node-cards.webp"
PIXEL="$SITE/node_modules/@fontsource-variable/pixelify-sans/files/pixelify-sans-latin-wght-normal.woff2"
SANS="$SITE/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The dashboard in a browser frame: a bar with three squares and the LAN address, and a 2 px border.
magick "$SHOT" -resize 1000x "$TMP/shot.png"
magick -size 1000x34 xc:'#1a1d22' \
  -fill '#353b45' -draw 'rectangle 16,12 25,21' -draw 'rectangle 31,12 40,21' -draw 'rectangle 46,12 55,21' \
  -fill '#101215' -draw 'roundrectangle 330,7 670,27 5,5' \
  -font "$SANS" -pointsize 13 -fill '#a0a7af' -gravity north -annotate +0+10 '192.168.1.10:8080' \
  "$TMP/bar.png"
magick "$TMP/bar.png" "$TMP/shot.png" -append -bordercolor '#353b45' -border 2 "$TMP/frame.png"

# A strip of grass-block side texture (8 px per texture pixel), fading into the background.
{
  echo '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="48" shape-rendering="crispEdges">'
  greens=('#6db349' '#63a940' '#5b9d3a' '#69ae45'); dirt=('#7a5034' '#6f482e' '#86593a' '#805537' '#6a452c')
  for ((row = 0; row < 6; row++)); do
    for ((col = 0; col < 150; col++)); do
      r=$(( (col * 7919 + row * 104729 + col * row * 31) % 100 ))
      if (( row == 0 || (row == 1 && r < 50) || (row == 2 && r < 12) )); then c=${greens[$((r % 4))]}; else c=${dirt[$((r % 5))]}; fi
      echo "<rect x=\"$((col * 8))\" y=\"$((row * 8))\" width=\"8\" height=\"8\" fill=\"$c\"/>"
    done
  done
  echo '<defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0.3" stop-color="#101215" stop-opacity="0"/><stop offset="1" stop-color="#101215"/></linearGradient></defs>'
  echo '<rect width="1200" height="48" fill="url(#f)"/></svg>'
} >"$TMP/ground.svg"

# Sky, glow, title, tagline, the frame (cut by the bottom edge) and the ground over it.
magick -size 1200x630 gradient:'#151b27-#101215' \
  \( -size 1200x630 radial-gradient:'rgba(114,192,78,0.22)-rgba(114,192,78,0)' \) -compose over -composite \
  -background none \( "$SITE/public/favicon.svg" -resize 64x64 \) -geometry +64+52 -composite \
  -font "$PIXEL" -pointsize 62 -fill '#e9e7e1' -stroke '#e9e7e1' -strokewidth 1.4 -annotate +146+104 'MC Server Manager' \
  -stroke none -font "$SANS" -pointsize 30 -fill '#a0a7af' -annotate +66+172 'One panel for every Minecraft server on your LAN' \
  "$TMP/frame.png" -geometry +100+232 -composite \
  "$TMP/ground.svg" -geometry +0+582 -composite \
  -strip "$OUT"
echo "wrote $OUT ($(magick identify -format '%wx%h' "$OUT"))"
