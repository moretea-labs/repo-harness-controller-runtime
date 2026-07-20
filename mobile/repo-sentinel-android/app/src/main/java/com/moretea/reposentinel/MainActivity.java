package com.moretea.reposentinel;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int BG = Color.rgb(8, 12, 18);
    private static final int PANEL = Color.rgb(17, 25, 35);
    private static final int PANEL_2 = Color.rgb(22, 32, 44);
    private static final int TEXT = Color.rgb(242, 246, 248);
    private static final int MUTED = Color.rgb(148, 163, 184);
    private static final int GREEN = Color.rgb(56, 217, 150);
    private static final int AMBER = Color.rgb(251, 191, 36);
    private static final int RED = Color.rgb(248, 113, 113);

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private TextView sentinelStatus;
    private TextView agentStatus;
    private TextView heartbeatStatus;
    private TextView foregroundStatus;
    private LinearLayout eventsContainer;
    private EditText endpointInput;
    private EditText deviceIdInput;
    private EditText tokenInput;
    private EditText intentInput;
    private EditText targetInput;
    private TextView controllerResult;

    private final BroadcastReceiver refreshReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { refresh(); }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildContent());
        requestNotificationPermission();
        IntentFilter filter = new IntentFilter();
        filter.addAction(EventStore.ACTION_EVENTS_CHANGED);
        filter.addAction(SentinelService.ACTION_STATE_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(refreshReceiver, filter, RECEIVER_NOT_EXPORTED);
        else registerReceiver(refreshReceiver, filter);
        if (EventStore.readRecent(this, 1).isEmpty()) {
            EventStore.append(this, "app_ready", "Repo Sentinel 已就绪。启用哨兵模式或 Accessibility 执行代理开始使用。", "success");
        }
    }

    @Override protected void onResume() {
        super.onResume();
        refresh();
    }

    @Override protected void onDestroy() {
        try { unregisterReceiver(refreshReceiver); } catch (Exception ignored) {}
        executor.shutdownNow();
        super.onDestroy();
    }

    private View buildContent() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BG);
        LinearLayout root = vertical();
        root.setPadding(dp(18), dp(24), dp(18), dp(40));
        scroll.addView(root, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView title = text("Repo Sentinel", 30, TEXT, true);
        root.addView(title);
        TextView subtitle = text("repo-harness 移动助手 · 实体感知与 Android 执行节点", 14, MUTED, false);
        subtitle.setPadding(0, dp(4), 0, dp(18));
        root.addView(subtitle);

        LinearLayout summary = card();
        TextView summaryTitle = text("节点状态", 18, TEXT, true);
        summary.addView(summaryTitle);
        sentinelStatus = statusLine("哨兵模式", "检查中", MUTED);
        agentStatus = statusLine("执行代理", "检查中", MUTED);
        heartbeatStatus = statusLine("最近心跳", "尚未启动", MUTED);
        foregroundStatus = statusLine("当前前台", "未知", MUTED);
        summary.addView(sentinelStatus);
        summary.addView(agentStatus);
        summary.addView(heartbeatStatus);
        summary.addView(foregroundStatus);
        root.addView(summary, sectionParams());

        LinearLayout sentinel = card();
        sentinel.addView(sectionTitle("哨兵模式", "使用加速度与环境光传感器检测移动和明显环境变化。持续运行时会显示系统通知。"));
        LinearLayout sentinelButtons = horizontal();
        Button start = button("启动哨兵", true);
        start.setOnClickListener(v -> startSentinel());
        Button stop = button("停止", false);
        stop.setOnClickListener(v -> stopSentinel());
        sentinelButtons.addView(start, weightParams());
        sentinelButtons.addView(space());
        sentinelButtons.addView(stop, weightParams());
        sentinel.addView(sentinelButtons);
        Button demo = button("记录测试事件", false);
        demo.setOnClickListener(v -> EventStore.append(this, "manual_test", "用户手动记录了一条测试事件", "info"));
        sentinel.addView(demo, fullButtonParams());
        root.addView(sentinel, sectionParams());

        LinearLayout controller = card();
        controller.addView(sectionTitle("repo-harness 连接", "兼容现有 /mobile/intent 设备令牌、时间戳、nonce 与 HMAC-SHA256 请求签名。"));
        endpointInput = input("接口地址，例如 http://Mac-IP:8766/mobile/intent", false);
        endpointInput.setText(DeviceConfig.endpoint(this));
        deviceIdInput = input("设备 ID", false);
        deviceIdInput.setText(DeviceConfig.deviceId(this));
        tokenInput = input("设备令牌", true);
        tokenInput.setText(DeviceConfig.token(this));
        intentInput = input("请求 JSON", false);
        intentInput.setMinLines(3);
        intentInput.setGravity(Gravity.TOP);
        intentInput.setText("{\"intent\":\"list_plugins\"}");
        controller.addView(endpointInput, inputParams());
        controller.addView(deviceIdInput, inputParams());
        controller.addView(tokenInput, inputParams());
        controller.addView(intentInput, inputParams());
        LinearLayout controllerButtons = horizontal();
        Button save = button("保存配置", false);
        save.setOnClickListener(v -> saveConfig());
        Button send = button("发送请求", true);
        send.setOnClickListener(v -> sendIntent());
        controllerButtons.addView(save, weightParams());
        controllerButtons.addView(space());
        controllerButtons.addView(send, weightParams());
        controller.addView(controllerButtons);
        controllerResult = text("尚未连接", 13, MUTED, false);
        controllerResult.setPadding(0, dp(12), 0, 0);
        controllerResult.setTextIsSelectable(true);
        controller.addView(controllerResult);
        root.addView(controller, sectionParams());

        LinearLayout agent = card();
        agent.addView(sectionTitle("Android 执行代理", "手动开启 Accessibility 后，可读取当前页面的非敏感节点并按文本执行点击、返回和回桌面。"));
        Button accessibility = button("打开辅助功能设置", true);
        accessibility.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        agent.addView(accessibility, fullButtonParams());
        targetInput = input("要查找并点击的控件文字", false);
        agent.addView(targetInput, inputParams());
        LinearLayout agentButtons = horizontal();
        Button click = button("点击文字", false);
        click.setOnClickListener(v -> {
            boolean ok = RepoAccessibilityService.clickText(targetInput.getText().toString());
            toast(ok ? "已发送点击" : "点击失败或被安全策略阻止");
            refresh();
        });
        Button snapshot = button("读取页面", false);
        snapshot.setOnClickListener(v -> showSnapshot());
        agentButtons.addView(click, weightParams());
        agentButtons.addView(space());
        agentButtons.addView(snapshot, weightParams());
        agent.addView(agentButtons);
        LinearLayout navButtons = horizontal();
        Button back = button("返回", false);
        back.setOnClickListener(v -> RepoAccessibilityService.back());
        Button home = button("回桌面", false);
        home.setOnClickListener(v -> RepoAccessibilityService.home());
        navButtons.addView(back, weightParams());
        navButtons.addView(space());
        navButtons.addView(home, weightParams());
        agent.addView(navButtons, fullButtonParams());
        TextView safety = text("安全限制：不会读取密码字段；验证码、支付、下单和生物识别相关操作会被本地阻止。", 12, AMBER, false);
        safety.setPadding(0, dp(12), 0, 0);
        agent.addView(safety);
        root.addView(agent, sectionParams());

        LinearLayout events = card();
        events.addView(sectionTitle("事件时间线", "最多保留 250 条本地事件，不上传令牌、输入内容或密码字段。"));
        eventsContainer = vertical();
        events.addView(eventsContainer);
        root.addView(events, sectionParams());

        TextView footer = text("MVP 0.1 · 无 Root · 无隐藏录音录像 · 调试签名", 12, MUTED, false);
        footer.setGravity(Gravity.CENTER);
        root.addView(footer);
        return scroll;
    }

    private void startSentinel() {
        Intent intent = new Intent(this, SentinelService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent); else startService(intent);
        toast("正在启动哨兵模式");
    }

    private void stopSentinel() {
        Intent intent = new Intent(this, SentinelService.class).setAction(SentinelService.ACTION_STOP);
        startService(intent);
    }

    private void saveConfig() {
        DeviceConfig.save(this, endpointInput.getText().toString(), deviceIdInput.getText().toString(), tokenInput.getText().toString());
        toast("设备配置已保存到应用私有存储");
    }

    private void sendIntent() {
        saveConfig();
        controllerResult.setText("正在发送签名请求…");
        String endpoint = endpointInput.getText().toString().trim();
        String deviceId = deviceIdInput.getText().toString().trim();
        String token = tokenInput.getText().toString().trim();
        String body = intentInput.getText().toString().trim();
        executor.execute(() -> {
            MobileIntentClient.Result result = MobileIntentClient.post(endpoint, deviceId, token, body);
            runOnUiThread(() -> {
                if (result.ok) {
                    controllerResult.setText("HTTP " + result.status + "\n" + result.body);
                    controllerResult.setTextColor(GREEN);
                    EventStore.append(this, "controller_request", "repo-harness 移动请求成功，HTTP " + result.status, "success");
                } else {
                    controllerResult.setText(result.status > 0
                            ? "HTTP " + result.status + "\n" + result.body
                            : "连接失败：" + result.error);
                    controllerResult.setTextColor(RED);
                    EventStore.append(this, "controller_error", "repo-harness 连接失败：" + (result.error == null ? result.status : result.error), "warning");
                }
            });
        });
    }

    private void showSnapshot() {
        String snapshot = RepoAccessibilityService.snapshot();
        new AlertDialog.Builder(this)
                .setTitle("当前页面可访问性快照")
                .setMessage(snapshot)
                .setPositiveButton("关闭", null)
                .show();
    }

    private void refresh() {
        if (sentinelStatus == null) return;
        boolean running = SentinelService.isRunning(this);
        sentinelStatus.setText("哨兵模式    " + (running ? "● 运行中" : "○ 已停止"));
        sentinelStatus.setTextColor(running ? GREEN : MUTED);
        boolean agent = RepoAccessibilityService.isConnected() || isAccessibilityEnabled();
        agentStatus.setText("执行代理    " + (agent ? "● 已启用" : "○ 未启用"));
        agentStatus.setTextColor(agent ? GREEN : AMBER);
        long heartbeat = getSharedPreferences("repo-sentinel-runtime", MODE_PRIVATE).getLong("last_heartbeat", 0L);
        heartbeatStatus.setText("最近心跳    " + (heartbeat == 0 ? "尚未启动" : relativeTime(heartbeat)));
        String foreground = getSharedPreferences("repo-sentinel-runtime", MODE_PRIVATE).getString("foreground_package", "未知");
        foregroundStatus.setText("当前前台    " + foreground);
        refreshEvents();
    }

    private void refreshEvents() {
        if (eventsContainer == null) return;
        eventsContainer.removeAllViews();
        List<EventStore.Event> events = EventStore.readRecent(this, 20);
        if (events.isEmpty()) {
            eventsContainer.addView(text("暂无事件", 13, MUTED, false));
            return;
        }
        SimpleDateFormat format = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault());
        for (EventStore.Event event : events) {
            LinearLayout row = vertical();
            row.setPadding(dp(12), dp(10), dp(12), dp(10));
            row.setBackground(roundRect(PANEL_2, 12));
            TextView meta = text(format.format(new Date(event.timestamp)) + "  ·  " + event.type, 11, MUTED, false);
            TextView message = text(event.message, 14, TEXT, false);
            message.setPadding(0, dp(3), 0, 0);
            row.addView(meta);
            row.addView(message);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT);
            params.bottomMargin = dp(8);
            eventsContainer.addView(row, params);
        }
    }

    private boolean isAccessibilityEnabled() {
        String enabled = Settings.Secure.getString(getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (enabled == null) return false;
        ComponentName component = new ComponentName(this, RepoAccessibilityService.class);
        return enabled.toLowerCase(Locale.ROOT).contains(component.flattenToString().toLowerCase(Locale.ROOT));
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 301);
        }
    }

    private LinearLayout vertical() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private LinearLayout horizontal() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.HORIZONTAL);
        layout.setGravity(Gravity.CENTER_VERTICAL);
        return layout;
    }

    private LinearLayout card() {
        LinearLayout card = vertical();
        card.setPadding(dp(16), dp(16), dp(16), dp(16));
        card.setBackground(roundRect(PANEL, 18));
        return card;
    }

    private View sectionTitle(String title, String description) {
        LinearLayout group = vertical();
        group.addView(text(title, 18, TEXT, true));
        TextView detail = text(description, 13, MUTED, false);
        detail.setPadding(0, dp(4), 0, dp(14));
        group.addView(detail);
        return group;
    }

    private TextView statusLine(String label, String value, int color) {
        TextView view = text(label + "    " + value, 14, color, false);
        view.setPadding(0, dp(9), 0, 0);
        return view;
    }

    private TextView text(String value, int sp, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        view.setLineSpacing(0, 1.12f);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private EditText input(String hint, boolean password) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setHintTextColor(Color.rgb(100, 116, 139));
        input.setTextColor(TEXT);
        input.setTextSize(14);
        input.setSingleLine(!hint.contains("JSON"));
        input.setPadding(dp(12), dp(10), dp(12), dp(10));
        input.setBackground(roundRect(PANEL_2, 12));
        if (password) input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        return input;
    }

    private Button button(String label, boolean primary) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(14);
        button.setAllCaps(false);
        button.setTextColor(primary ? Color.rgb(4, 30, 21) : TEXT);
        button.setBackground(roundRect(primary ? GREEN : PANEL_2, 12));
        button.setPadding(dp(12), 0, dp(12), 0);
        return button;
    }

    private View space() {
        View space = new View(this);
        space.setLayoutParams(new LinearLayout.LayoutParams(dp(8), 1));
        return space;
    }

    private GradientDrawable roundRect(int color, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        drawable.setStroke(dp(1), Color.argb(30, 255, 255, 255));
        return drawable;
    }

    private LinearLayout.LayoutParams sectionParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(14);
        return params;
    }

    private LinearLayout.LayoutParams inputParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(9);
        return params;
    }

    private LinearLayout.LayoutParams fullButtonParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        params.topMargin = dp(9);
        return params;
    }

    private LinearLayout.LayoutParams weightParams() {
        return new LinearLayout.LayoutParams(0, dp(48), 1f);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private String relativeTime(long timestamp) {
        long seconds = Math.max(0, (System.currentTimeMillis() - timestamp) / 1000);
        if (seconds < 10) return "刚刚";
        if (seconds < 60) return seconds + " 秒前";
        if (seconds < 3600) return seconds / 60 + " 分钟前";
        return new SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(new Date(timestamp));
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }
}
