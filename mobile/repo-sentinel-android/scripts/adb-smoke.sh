#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.toolchain/env.sh"
ADB="$ANDROID_SDK_ROOT/platform-tools/adb"
PACKAGE="com.moretea.reposentinel"

$ADB shell am force-stop "$PACKAGE"
$ADB shell am start -W -n "$PACKAGE/.MainActivity"
CURRENT="$($ADB shell dumpsys window | grep -m1 -E 'mCurrentFocus|mFocusedApp' || true)"
printf '%s\n' "$CURRENT"
[[ "$CURRENT" == *"$PACKAGE"* ]]

$ADB shell am start-foreground-service -n "$PACKAGE/.SentinelService"
sleep 2
$ADB shell dumpsys activity services "$PACKAGE" | grep -q 'SentinelService'
$ADB shell am startservice -a com.moretea.reposentinel.STOP_SENTINEL -n "$PACKAGE/.SentinelService" >/dev/null
printf 'ADB smoke passed.\n'
