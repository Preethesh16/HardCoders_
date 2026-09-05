#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MEDIA_DIR="$ROOT_DIR/docs/assets/readme/demo"
AUDIO="$MEDIA_DIR/anchor-demo-narration.mp3"
OUTPUT="$MEDIA_DIR/anchor-demo.mp4"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Start on the deployed landing page, then show both user roles, the full deal,
# infrastructure proof, and the acceptance result.
SCENES=(
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
  11-milestone-1-delivery.png
  12-milestone-1-fabric-review.png
  13-milestone-1-route-optimizer.png
  11-milestone-2-delivery.png
  12-milestone-2-fabric-review.png
  13-milestone-2-route-optimizer.png
  14-completed-settlement.png
  15-freelancer-paid.png
  19-supabase.png
  20-minio.png
  16-data-plane.png
  18-digitalocean.png
  17-proof.png
)

TARGET_DURATION=150
FPS=30
TRANSITION=0.55
SCENE_COUNT="${#SCENES[@]}"
SCENE_DURATION="$(awk -v target="$TARGET_DURATION" -v count="$SCENE_COUNT" -v transition="$TRANSITION" 'BEGIN { printf "%.6f", (target + (count - 1) * transition) / count }')"
FRAME_COUNT="$(awk -v duration="$SCENE_DURATION" -v fps="$FPS" 'BEGIN { printf "%d", duration * fps + 1 }')"

clips=()
for index in "${!SCENES[@]}"; do
  scene="$MEDIA_DIR/${SCENES[$index]}"
  clip="$WORK_DIR/$(printf '%02d' "$index").mp4"
  if (( index % 2 == 0 )); then
    y_pan="(ih-720)*(n/$FRAME_COUNT)"
  else
    y_pan="(ih-720)*(1-n/$FRAME_COUNT)"
  fi

  ffmpeg -loglevel error -y -loop 1 -i "$scene" \
    -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720:x='(iw-1280)/2':y='$y_pan',fps=$FPS,format=yuv420p" \
    -frames:v "$FRAME_COUNT" -an -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p "$clip"
  clips+=("$clip")
done

inputs=()
for clip in "${clips[@]}"; do
  inputs+=( -i "$clip" )
done

filter=""
previous="0:v"
for (( index=1; index<SCENE_COUNT; index++ )); do
  output="v$index"
  offset="$(awk -v step="$index" -v duration="$SCENE_DURATION" -v transition="$TRANSITION" 'BEGIN { printf "%.6f", step * (duration - transition) }')"
  filter+="[$previous][$index:v]xfade=transition=fade:duration=$TRANSITION:offset=$offset[$output];"
  previous="$output"
done
filter="${filter%;}"

ffmpeg -loglevel error -y "${inputs[@]}" -i "$AUDIO" \
  -filter_complex "$filter" -map "[$previous]" -map "$SCENE_COUNT:a:0" \
  -af "apad" -t "$TARGET_DURATION" -r "$FPS" \
  -c:v libx264 -preset slow -crf 30 -profile:v high -level 4.0 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart "$OUTPUT"

ffmpeg -loglevel error -y -ss 2 -i "$OUTPUT" -frames:v 1 "$MEDIA_DIR/anchor-demo-poster.png"

printf 'Created %s (%ss, continuous motion, native aspect ratio)\n' "$OUTPUT" "$TARGET_DURATION"
