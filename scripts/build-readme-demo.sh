#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MEDIA_DIR="$ROOT_DIR/docs/assets/readme/demo"
AUDIO="$MEDIA_DIR/anchor-demo-narration.mp3"
OUTPUT="$MEDIA_DIR/anchor-demo.mp4"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

SCENES=(
  00-title.png
  01-landing.png
  02-company-portal.png
  04-company-policy-authorized.png
  05-ai-document-extraction.png
  03-freelancer-portal.png
  06-freelancer-opportunity.png
  07-ai-ranked-proposals.png
  08-company-agreement.png
  09-freelancer-agreement.png
  10-compliance-fx-escrow.png
  16-data-plane.png
  11-milestone-1-delivery.png
  12-milestone-1-fabric-review.png
  13-milestone-1-route-optimizer.png
  11-milestone-2-delivery.png
  12-milestone-2-fabric-review.png
  13-milestone-2-route-optimizer.png
  14-completed-settlement.png
  15-freelancer-paid.png
  17-proof.png
)

AUDIO_DURATION="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$AUDIO")"
SCENE_DURATION="$(awk -v duration="$AUDIO_DURATION" -v count="${#SCENES[@]}" 'BEGIN { printf "%.4f", duration / count }')"
FADE_OUT="$(awk -v duration="$SCENE_DURATION" 'BEGIN { printf "%.4f", duration - 0.35 }')"

: > "$WORK_DIR/concat.txt"
for index in "${!SCENES[@]}"; do
  scene="$MEDIA_DIR/${SCENES[$index]}"
  clip="$WORK_DIR/$(printf '%02d' "$index").mp4"
  ffmpeg -loglevel error -y -loop 1 -i "$scene" -t "$SCENE_DURATION" \
    -vf "scale=1280:686:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=#061c15,fade=t=in:st=0:d=0.35,fade=t=out:st=$FADE_OUT:d=0.35,format=yuv420p" \
    -r 30 -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p "$clip"
  printf "file '%s'\n" "$clip" >> "$WORK_DIR/concat.txt"
done

ffmpeg -loglevel error -y -f concat -safe 0 -i "$WORK_DIR/concat.txt" -i "$AUDIO" \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 160k -shortest -movflags +faststart "$OUTPUT"
ffmpeg -loglevel error -y -ss 8 -i "$OUTPUT" -frames:v 1 "$MEDIA_DIR/anchor-demo-poster.png"

printf 'Created %s\n' "$OUTPUT"
