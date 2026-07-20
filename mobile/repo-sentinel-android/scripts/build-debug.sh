#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/bootstrap-toolchain.sh"
# shellcheck disable=SC1091
source "$ROOT/.toolchain/env.sh"
cd "$ROOT"
./gradlew --no-daemon --stacktrace assembleDebug
mkdir -p dist
cp app/build/outputs/apk/debug/app-debug.apk dist/RepoSentinel-0.1.0-debug.apk
shasum -a 256 dist/RepoSentinel-0.1.0-debug.apk | tee dist/RepoSentinel-0.1.0-debug.apk.sha256
printf 'APK: %s\n' "$ROOT/dist/RepoSentinel-0.1.0-debug.apk"
