# 本机系统助手

`local_system` 是 Controller 级插件，用于偶尔处理本机诊断、打开应用和受控文件操作。它不要求注册 Git 仓库，也不会创建假的仓库记录。

## 可以做什么

- 查看有边界的 CPU、进程、内存与内存压力快照。
- 查看指定 PID 的进程信息。
- 按应用名称或 Bundle ID 打开 macOS 应用。
- 在 Finder 中显示已授权文件，或用默认应用打开文件。
- 在已授权目录中列目录、读取文本、新建目录、复制、移动和重命名文件。

## 安全边界

- 没有任意 shell、`sudo`、删除文件或辅助功能点击能力。
- 目录必须先通过 `authorize_target` 授权，并使用有期限的 `target_key`；最长有效期 24 小时。
- 所有文件路径必须是目标目录下的相对路径。
- 系统同时检查路径穿越和符号链接逃逸。
- 复制、移动和重命名默认拒绝覆盖已有文件。
- 诊断、列目录和读取文本不需要确认；授权目录、打开应用和文件写操作需要正常授权。

## 在 ChatGPT 中使用

无需传入 `repo_id`：

```text
列出 local_system 插件能力。
查看当前 CPU 和内存压力。
打开 Xcode。
授权 ~/Documents/Reports 为 reports，使用 60 分钟。
读取 reports 下的 summary.txt。
```

ChatGPT 会通过现有 `list_plugins`、`get_plugin` 和 `plugin_action_execute` 工具调用插件，因此不需要重新连接或增加新的 MCP 工具。

插件状态、任务、授权目标和证据存放在 `controllerHome/system/`，不会写入 Repository Registry。

## iOS 自动化说明

iOS smoke review 现在会等待 Simulator 完全启动，使用每次构建独立的 DerivedData，确定性选择 App 产物，在启动后等待页面稳定，并记录模拟器是否由本次任务启动。可以使用：

- `cleanup_policy=keep`
- `cleanup_policy=shutdown_on_success`
- `cleanup_policy=shutdown_always`

系统只会自动关闭由当前任务启动的模拟器，不会关闭原本已经运行的设备。截图和日志会生成可读取的 Artifact 引用。
