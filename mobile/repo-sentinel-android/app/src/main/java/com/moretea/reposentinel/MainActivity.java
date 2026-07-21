package com.moretea.reposentinel;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class MainActivity extends Activity implements AodMonitorView.Actions {
    private static final long CLOCK_TICK_MS = 1_000L;
    private static final long MIN_POLL_MS = 5_000L;
    private static final long MAX_ERROR_POLL_MS = 30_000L;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean pollInFlight = new AtomicBoolean(false);

    private AodMonitorView dashboard;
    private DeviceStatus.Snapshot deviceStatus;
    private MonitorSnapshot lastSnapshot;
    private long lastFetchedAt;
    private int consecutiveFailures;
    private boolean detailVisible;

    private final Runnable clockTicker = new Runnable() {
        @Override public void run() {
            if (dashboard != null) dashboard.tick();
            mainHandler.postDelayed(this, CLOCK_TICK_MS);
        }
    };

    private final Runnable poller = new Runnable() {
        @Override public void run() {
            pollNow();
        }
    };

    private final BroadcastReceiver batteryReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            deviceStatus = DeviceStatus.collect(MainActivity.this);
            if (dashboard != null) dashboard.updateDevice(deviceStatus);
            applyPowerPolicy(detailVisible);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        dashboard = new AodMonitorView(this);
        dashboard.setActions(this);
        setContentView(dashboard);
        deviceStatus = DeviceStatus.collect(this);
        dashboard.updateDevice(deviceStatus);
        enterImmersiveMode();
        registerReceiver(batteryReceiver, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        applyPowerPolicy(false);
        showCurrentConfigurationState();
    }

    @Override
    protected void onResume() {
        super.onResume();
        enterImmersiveMode();
        mainHandler.removeCallbacks(clockTicker);
        mainHandler.post(clockTicker);
        schedulePoll(0L);
        applyPowerPolicy(detailVisible);
    }

    @Override
    protected void onPause() {
        mainHandler.removeCallbacks(clockTicker);
        mainHandler.removeCallbacks(poller);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacksAndMessages(null);
        networkExecutor.shutdownNow();
        try {
            unregisterReceiver(batteryReceiver);
        } catch (IllegalArgumentException ignored) {}
        super.onDestroy();
    }

    private void showCurrentConfigurationState() {
        boolean configured = isConfigured();
        dashboard.showConnectionState(configured, configured ? "正在连接" : null);
    }

    private boolean isConfigured() {
        return !DeviceConfig.endpoint(this).isBlank()
                && !DeviceConfig.deviceId(this).isBlank()
                && !DeviceConfig.token(this).isBlank();
    }

    private void pollNow() {
        mainHandler.removeCallbacks(poller);
        if (!isConfigured()) {
            dashboard.showConnectionState(false, null);
            schedulePoll(15_000L);
            return;
        }
        if (!pollInFlight.compareAndSet(false, true)) return;

        String endpoint = DeviceConfig.endpoint(this);
        String deviceId = DeviceConfig.deviceId(this);
        String token = DeviceConfig.token(this);
        networkExecutor.execute(() -> {
            MonitorApiClient.Result result = MonitorApiClient.fetchSnapshot(endpoint, deviceId, token);
            mainHandler.post(() -> {
                pollInFlight.set(false);
                deviceStatus = DeviceStatus.collect(MainActivity.this);
                if (result.ok()) {
                    consecutiveFailures = 0;
                    lastSnapshot = result.snapshot;
                    lastFetchedAt = System.currentTimeMillis();
                    dashboard.update(lastSnapshot, lastFetchedAt, deviceStatus);
                    schedulePoll(result.snapshot.pollAfterMs);
                } else {
                    consecutiveFailures++;
                    dashboard.updateDevice(deviceStatus);
                    dashboard.showConnectionState(true, result.error);
                    long retry = Math.min(MAX_ERROR_POLL_MS,
                            MIN_POLL_MS * (1L << Math.min(3, Math.max(0, consecutiveFailures - 1))));
                    schedulePoll(retry);
                }
                applyPowerPolicy(detailVisible);
            });
        });
    }

    private void schedulePoll(long delayMs) {
        mainHandler.removeCallbacks(poller);
        mainHandler.postDelayed(poller, Math.max(0L, delayMs));
    }

    @Override
    public void openConfiguration() {
        final int padding = dp(22);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(padding, dp(8), padding, 0);

        TextView help = new TextView(this);
        help.setText("连接 Mac 上的 repo-harness 只读监控接口。令牌只保存在本机应用私有目录。\n\n地址示例：http://192.168.1.10:8766");
        help.setTextColor(Color.rgb(130, 140, 150));
        help.setTextSize(13);
        help.setLineSpacing(0f, 1.15f);
        layout.addView(help, matchWrap(dp(0), dp(12)));

        EditText endpoint = field("Mac 监控地址", DeviceConfig.endpoint(this));
        endpoint.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        layout.addView(endpoint, matchWrap(dp(0), dp(10)));

        EditText deviceId = field("设备 ID", DeviceConfig.deviceId(this));
        layout.addView(deviceId, matchWrap(dp(0), dp(10)));

        EditText token = field("只读设备令牌", DeviceConfig.token(this));
        token.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        layout.addView(token, matchWrap(dp(0), dp(4)));

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("监控连接")
                .setView(layout)
                .setNegativeButton("取消", null)
                .setPositiveButton("保存并连接", null)
                .create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String baseEndpoint = MonitorApiClient.normalizeBaseEndpoint(endpoint.getText().toString());
            String id = deviceId.getText().toString().trim();
            String secret = token.getText().toString().trim();
            if (!(baseEndpoint.startsWith("http://") || baseEndpoint.startsWith("https://"))) {
                endpoint.setError("请输入完整的 http:// 或 https:// 地址");
                return;
            }
            if (id.isBlank()) {
                deviceId.setError("设备 ID 不能为空");
                return;
            }
            if (secret.isBlank()) {
                token.setError("令牌不能为空");
                return;
            }
            DeviceConfig.save(this, baseEndpoint, id, secret);
            consecutiveFailures = 0;
            dashboard.showConnectionState(true, "正在连接");
            dialog.dismiss();
            Toast.makeText(this, "连接配置已保存", Toast.LENGTH_SHORT).show();
            schedulePoll(0L);
        }));
        dialog.show();
    }

    private EditText field(String hint, String value) {
        EditText field = new EditText(this);
        field.setHint(hint);
        field.setText(value == null ? "" : value);
        field.setTextSize(15);
        field.setSingleLine(true);
        field.setSelectAllOnFocus(false);
        field.setPadding(dp(2), dp(8), dp(2), dp(8));
        return field;
    }

    private LinearLayout.LayoutParams matchWrap(int top, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, top, 0, bottom);
        return params;
    }

    @Override
    public void onDetailVisibilityChanged(boolean visible) {
        detailVisible = visible;
        applyPowerPolicy(visible);
        if (visible) {
            mainHandler.postDelayed(() -> {
                if (detailVisible) {
                    detailVisible = false;
                    dashboard.setDetailVisible(false);
                    applyPowerPolicy(false);
                }
            }, 30_000L);
        }
    }

    private void applyPowerPolicy(boolean interactionBoost) {
        Window window = getWindow();
        WindowManager.LayoutParams attributes = window.getAttributes();
        boolean charging = deviceStatus != null && deviceStatus.charging;
        dashboard.setKeepScreenOn(charging);
        if (charging) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            attributes.screenBrightness = interactionBoost ? 0.10f : 0.025f;
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            attributes.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
        }
        window.setAttributes(attributes);
    }

    private void enterImmersiveMode() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
