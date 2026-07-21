# Repo Sentinel Android

Repo Sentinel 是 repo-harness 的 Android 移动助手和实体感知节点。MVP 不需要 Root 或解锁 Bootloader，面向 Android 8.0 以上设备，并针对 Redmi K50 / Android 14 进行真机交付。

## 当前能力

- 原生 Android 控制台：哨兵状态、执行代理状态、心跳、前台 App、事件时间线。
- 可见前台 Sentinel Service：使用加速度计和环境光传感器记录设备移动与明显光线变化。
- repo-harness `/mobile/intent` 客户端：设备令牌、时间戳、nonce、Bearer 与 HMAC-SHA256 签名。
- Accessibility 执行代理：读取当前页面的非敏感节点、按文本/描述/resource-id 点击、返回、回桌面和手势基础能力。
- 本地安全限制：密码节点始终脱敏；验证码、密码、支付、下单、购买、结账和生物识别语义会被阻止。
- 事件只保存在应用私有目录，最多保留约 250 条。

## 构建

本项目自带可复现的 macOS Apple Silicon 工具链引导，不要求预装 Android Studio、JDK 或 Gradle：

```bash
cd mobile/repo-sentinel-android
./scripts/build-debug.sh
```

脚本会把临时 JDK、Android SDK 和 Gradle 放在 `.toolchain/`，不会修改系统 Java 或全局 Android SDK。APK 输出到：

```text
dist/RepoSentinel-0.1.0-debug.apk
```

## 安装到手机

1. 在手机中启用开发者选项和 USB 调试。
2. 连接 USB，并在手机上接受这台 Mac 的调试授权。
3. 执行：

```bash
./scripts/install-debug.sh
```

也可以直接把 APK 复制到手机后安装。此 APK 使用 Android 调试签名，仅适合个人测试。

HyperOS 若返回 `INSTALL_FAILED_USER_RESTRICTED`，需要在开发者选项中启用“USB 安装”，或从 Downloads 打开 APK 并在系统安装器中手动确认。

## 首次使用

1. 打开 Repo Sentinel，允许通知。
2. 点击“启动哨兵”，确认状态栏出现持续通知。
3. 点击“打开辅助功能设置”，找到“Repo Sentinel 执行代理”并手动启用。
4. 返回 App，执行代理状态应变为“已启用”。
5. 在执行真实流程前，先用“读取页面”和无副作用页面验证 Selector。

HyperOS 建议额外设置：允许自启动、后台电量策略设为无限制，并在最近任务中锁定应用。系统仍可能在极端内存压力下停止进程，前台服务心跳用于识别这种情况。

## 连接 repo-harness

Mac 侧只开放现有受限移动入口：

```bash
repo-harness controller ui --repo . --host 0.0.0.0 --mobile-lan
```

在本机 Local Controller 中创建移动设备令牌，将范围限制为实际需要的 plugin/job actions。然后在 App 填入：

- 接口地址：`http://<Mac 局域网地址>:8766/mobile/intent`
- 设备 ID：创建令牌时返回的设备 ID
- 设备令牌：仅显示一次的设备令牌

默认测试请求：

```json
{"intent":"list_plugins"}
```

令牌存放在应用私有 SharedPreferences。MVP 尚未迁移到 Android Keystore 加密容器，因此不要在共用或不受信任的手机中保存高权限令牌；应创建最小权限、可随时撤销的独立设备令牌。

## 安全边界

Repo Sentinel 不实现以下能力：

- 隐藏摄像、隐藏录音或后台无提示采集。
- 验证码/CAPTCHA 绕过。
- 密码、支付信息或身份验证器数据采集。
- 自动确认下单、购买、付款或生物识别。
- Root、Bootloader 解锁、Shizuku 或任意 shell 执行。

Accessibility 只能由用户在系统设置中手动开启。App 中的点击能力应配合 App 白名单和确定性 Flow 使用；MVP 目前提供本地手动测试入口，尚未开放远程任意 UI 指令。

## 项目结构

```text
app/src/main/java/com/moretea/reposentinel/
├── MainActivity.java               原生移动控制台
├── SentinelService.java            前台心跳与传感器哨兵
├── RepoAccessibilityService.java   受限 Android UI 执行代理
├── MobileIntentClient.java         repo-harness 签名请求客户端
├── EventStore.java                 本地事件时间线
└── DeviceConfig.java               设备连接配置
```

## 后续方向

- CameraX 按需预览、运动触发快照和明确可见的摄像头前台服务。
- WebRTC 按需实时画面与双向语音。
- `/mobile/v1/*` 配对、状态、Inbox、Run 与事件推送 API。
- Android Keystore 设备密钥和二维码配对。
- repo-harness 下发签名的确定性 Flow，而不是远程任意点击。
- 人工接管、失败截图和 Evidence Plane 集成。
