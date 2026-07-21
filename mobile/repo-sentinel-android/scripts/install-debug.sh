#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK="$ROOT/dist/RepoSentinel-0.1.0-debug.apk"
if [[ ! -f "$APK" ]]; then "$ROOT/scripts/build-debug.sh"; fi
# shellcheck disable=SC1091
source "$ROOT/.toolchain/env.sh"
ADB="$ANDROID_SDK_ROOT/platform-tools/adb"
"$ADB" start-server >/dev/null
DEVICE_COUNT="$($ADB devices | awk 'NR>1 && $2=="device" {count++} END {print count+0}')"
if [[ "$DEVICE_COUNT" -ne 1 ]]; then
  echo "需要且只能连接一台已授权 Android 设备；当前可用设备数：$DEVICE_COUNT" >&2
  "$ADB" devices -l >&2
  exit 2
fi
"$ADB" install -r "$APK"
"$ADB" shell am force-stop com.moretea.reposentinel
"$ADB" shell am start -W -n com.moretea.reposentinel/.MainActivity
printf 'Repo Sentinel 已安装并启动。\n'
