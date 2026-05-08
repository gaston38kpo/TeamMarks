#!/usr/bin/env bash
# TeamMarks — Download Supabase Browser Bundle
#
# This script downloads the Supabase JS client v2 UMD bundle
# and saves it as lib/supabase-browser.js for use by the extension.
#
# Run this script from the project root:
#   bash scripts/download-supabase.sh

set -euo pipefail

BUNDLE_URL="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_PATH="${SCRIPT_DIR}/../lib/supabase-browser.js"

echo "Downloading Supabase JS client from CDN..."
echo "  URL: ${BUNDLE_URL}"
echo "  Output: ${OUTPUT_PATH}"

if command -v curl &>/dev/null; then
    curl -fSL -o "${OUTPUT_PATH}" "${BUNDLE_URL}"
elif command -v wget &>/dev/null; then
    wget -q -O "${OUTPUT_PATH}" "${BUNDLE_URL}"
else
    echo "ERROR: Neither curl nor wget found. Please install one and retry." >&2
    exit 1
fi

FILE_SIZE=$(wc -c < "${OUTPUT_PATH}")
echo ""
echo "Download complete! (${FILE_SIZE} bytes)"
echo "The bundle is now at lib/supabase-browser.js"