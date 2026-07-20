#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$ROOT/.toolchain"
DOWNLOADS="$TOOLS/downloads"
JDK_DIST="$TOOLS/jdk-dist"
SDK_ROOT="$TOOLS/android-sdk"
GRADLE_HOME="$TOOLS/gradle-8.13"
CMDLINE_VERSION="14742923"

mkdir -p "$DOWNLOADS" "$TOOLS"

log() { printf '[repo-sentinel] %s\n' "$*"; }

download() {
  local url="$1" target="$2"
  if [[ -s "$target" ]]; then return 0; fi
  log "下载 $(basename "$target")"
  curl --fail --location --retry 4 --retry-delay 2 --connect-timeout 20 "$url" -o "$target.part"
  mv "$target.part" "$target"
}

resolve_java_home() {
  find "$JDK_DIST" -type d -path '*/Contents/Home' -print -quit 2>/dev/null || true
}

JAVA_HOME_VALUE="$(resolve_java_home)"
if [[ -z "$JAVA_HOME_VALUE" || ! -x "$JAVA_HOME_VALUE/bin/java" ]]; then
  rm -rf "$JDK_DIST"
  mkdir -p "$JDK_DIST"
  JDK_ARCHIVE="$DOWNLOADS/temurin-jdk17-macos-aarch64.tar.gz"
  download "https://api.adoptium.net/v3/binary/latest/17/ga/mac/aarch64/jdk/hotspot/normal/eclipse" "$JDK_ARCHIVE"
  log "解压 JDK 17"
  tar -xzf "$JDK_ARCHIVE" -C "$JDK_DIST"
  JAVA_HOME_VALUE="$(resolve_java_home)"
fi
if [[ -z "$JAVA_HOME_VALUE" || ! -x "$JAVA_HOME_VALUE/bin/java" ]]; then
  echo "无法准备 JDK 17" >&2
  exit 1
fi
export JAVA_HOME="$JAVA_HOME_VALUE"
export PATH="$JAVA_HOME/bin:$PATH"

if [[ ! -x "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]]; then
  CMD_ARCHIVE="$DOWNLOADS/commandlinetools-mac-${CMDLINE_VERSION}_latest.zip"
  download "https://dl.google.com/android/repository/commandlinetools-mac-${CMDLINE_VERSION}_latest.zip" "$CMD_ARCHIVE"
  rm -rf "$TOOLS/cmdline-unpack" "$SDK_ROOT/cmdline-tools/latest"
  mkdir -p "$TOOLS/cmdline-unpack" "$SDK_ROOT/cmdline-tools/latest"
  log "解压 Android Command-line Tools"
  unzip -q "$CMD_ARCHIVE" -d "$TOOLS/cmdline-unpack"
  cp -R "$TOOLS/cmdline-unpack/cmdline-tools/." "$SDK_ROOT/cmdline-tools/latest/"
fi

export ANDROID_HOME="$SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export PATH="$SDK_ROOT/cmdline-tools/latest/bin:$SDK_ROOT/platform-tools:$PATH"
SDKMANAGER="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"

log "接受 Android SDK 许可证"
yes | "$SDKMANAGER" --sdk_root="$SDK_ROOT" --licenses >/dev/null 2>&1 || true
log "安装 Android SDK Platform 36 与 Build Tools"
"$SDKMANAGER" --sdk_root="$SDK_ROOT" \
  "platform-tools" \
  "platforms;android-36" \
  "build-tools;36.0.0"

if [[ ! -x "$GRADLE_HOME/bin/gradle" ]]; then
  GRADLE_ARCHIVE="$DOWNLOADS/gradle-8.13-bin.zip"
  download "https://services.gradle.org/distributions/gradle-8.13-bin.zip" "$GRADLE_ARCHIVE"
  rm -rf "$GRADLE_HOME"
  log "解压 Gradle 8.13"
  unzip -q "$GRADLE_ARCHIVE" -d "$TOOLS"
fi

cat > "$ROOT/local.properties" <<PROPS
sdk.dir=$SDK_ROOT
PROPS

if [[ ! -x "$ROOT/gradlew" ]]; then
  log "生成 Gradle Wrapper"
  WRAPPER_TMP="$TOOLS/wrapper-project"
  rm -rf "$WRAPPER_TMP"
  mkdir -p "$WRAPPER_TMP"
  cat > "$WRAPPER_TMP/settings.gradle" <<'WRAPPER_SETTINGS'
rootProject.name = 'wrapper-bootstrap'
WRAPPER_SETTINGS
  : > "$WRAPPER_TMP/build.gradle"
  "$GRADLE_HOME/bin/gradle" -p "$WRAPPER_TMP" wrapper --gradle-version 8.13 --distribution-type bin --no-daemon --stacktrace
  cp "$WRAPPER_TMP/gradlew" "$ROOT/gradlew"
  cp "$WRAPPER_TMP/gradlew.bat" "$ROOT/gradlew.bat"
  mkdir -p "$ROOT/gradle/wrapper"
  cp "$WRAPPER_TMP/gradle/wrapper/gradle-wrapper.jar" "$ROOT/gradle/wrapper/gradle-wrapper.jar"
  cp "$WRAPPER_TMP/gradle/wrapper/gradle-wrapper.properties" "$ROOT/gradle/wrapper/gradle-wrapper.properties"
  chmod +x "$ROOT/gradlew"
fi

cat > "$TOOLS/env.sh" <<ENV
export JAVA_HOME="$JAVA_HOME_VALUE"
export ANDROID_HOME="$SDK_ROOT"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export PATH="\$JAVA_HOME/bin:\$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:\$ANDROID_SDK_ROOT/platform-tools:\$PATH"
ENV

log "工具链就绪"
"$JAVA_HOME/bin/java" -version
"$SDK_ROOT/platform-tools/adb" version | head -2
