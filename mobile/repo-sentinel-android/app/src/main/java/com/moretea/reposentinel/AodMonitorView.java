package com.moretea.reposentinel;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;

import java.text.SimpleDateFormat;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.Locale;

public final class AodMonitorView extends View {
    public interface Actions {
        void openConfiguration();
        void onDetailVisibilityChanged(boolean visible);
    }

    private static final int BLACK = Color.BLACK;
    private static final int WHITE = Color.rgb(238, 242, 246);
    private static final int MUTED = Color.rgb(112, 124, 136);
    private static final int DIM = Color.rgb(65, 74, 83);
    private static final int GREEN = Color.rgb(70, 218, 139);
    private static final int AMBER = Color.rgb(255, 181, 66);
    private static final int RED = Color.rgb(255, 92, 92);
    private static final int BLUE = Color.rgb(94, 168, 255);

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint linePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final float density;
    private final float scaledDensity;
    private Actions actions;
    private MonitorSnapshot snapshot;
    private DeviceStatus.Snapshot deviceStatus;
    private String connectionError;
    private boolean configured;
    private boolean detailVisible;
    private long fetchedAt;
    private long touchDownAt;
    private float touchDownX;
    private float touchDownY;

    public AodMonitorView(Context context) {
        super(context);
        density = getResources().getDisplayMetrics().density;
        scaledDensity = getResources().getDisplayMetrics().scaledDensity;
        paint.setTypeface(Typeface.create("sans", Typeface.NORMAL));
        linePaint.setStrokeWidth(dp(1));
        linePaint.setColor(DIM);
        setBackgroundColor(BLACK);
        setKeepScreenOn(true);
    }

    public void setActions(Actions actions) {
        this.actions = actions;
    }

    public void update(MonitorSnapshot snapshot, long fetchedAt, DeviceStatus.Snapshot deviceStatus) {
        this.snapshot = snapshot;
        this.fetchedAt = fetchedAt;
        this.deviceStatus = deviceStatus;
        this.connectionError = null;
        this.configured = true;
        invalidate();
    }

    public void updateDevice(DeviceStatus.Snapshot deviceStatus) {
        this.deviceStatus = deviceStatus;
        invalidate();
    }

    public void showConnectionState(boolean configured, String error) {
        this.configured = configured;
        this.connectionError = error;
        invalidate();
    }

    public void tick() {
        invalidate();
    }

    public void setDetailVisible(boolean visible) {
        detailVisible = visible;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        long burnIndex = System.currentTimeMillis() / 180_000L;
        float shiftX = ((burnIndex % 3) - 1) * dp(4);
        float shiftY = (((burnIndex / 3) % 3) - 1) * dp(4);
        canvas.save();
        canvas.translate(shiftX, shiftY);
        if (detailVisible) drawDetail(canvas); else drawAmbient(canvas);
        canvas.restore();
    }

    private void drawAmbient(Canvas canvas) {
        float left = dp(38);
        float right = getWidth() - dp(38);
        float y = dp(76);

        String time = new SimpleDateFormat("HH:mm", Locale.CHINA).format(new Date());
        String date = new SimpleDateFormat("M月d日 EEEE", Locale.CHINA).format(new Date());
        text(canvas, time, left, y + sp(70), 70, WHITE, true);
        text(canvas, date, left + dp(3), y + sp(99), 13, MUTED, false);

        StateView state = stateView();
        float statusY = y + sp(180);
        dot(canvas, left + dp(8), statusY - dp(8), state.color, dp(7));
        text(canvas, state.label, left + dp(30), statusY, 27, state.color, true);
        textFit(canvas, state.detail, left + dp(30), statusY + sp(27), right - left - dp(30), 13, MUTED, false);

        float mainY = statusY + dp(100);
        if (!configured) {
            drawUnconfigured(canvas, left, right, mainY);
        } else if (isOfflineOrStale()) {
            drawOffline(canvas, left, right, mainY);
        } else if (snapshot != null && !snapshot.attention.isEmpty()) {
            drawAttention(canvas, left, right, mainY, snapshot.attention.get(0));
        } else if (snapshot != null && !snapshot.activeJobs.isEmpty()) {
            drawCurrentJob(canvas, left, right, mainY, snapshot.activeJobs.get(0));
        } else {
            drawIdle(canvas, left, right, mainY);
        }

        drawMetrics(canvas, left, right);
        text(canvas, "轻触查看详情  ·  长按配置连接", left, getHeight() - dp(28), 10, DIM, false);
    }

    private void drawUnconfigured(Canvas canvas, float left, float right, float y) {
        overline(canvas, "SETUP", left, y, BLUE);
        text(canvas, "还没有连接监控数据", left, y + sp(43), 25, WHITE, true);
        drawWrapped(canvas, "长按屏幕，配置 Mac 地址、设备 ID 和只读令牌。", left, y + sp(76), right - left, 14, MUTED, 2);
    }

    private void drawOffline(Canvas canvas, float left, float right, float y) {
        overline(canvas, "OFFLINE", left, y, RED);
        text(canvas, snapshot == null ? "无法连接到 Mac" : "监控数据已经过期", left, y + sp(43), 25, WHITE, true);
        String detail = connectionError == null || connectionError.isBlank()
                ? lastDataDescription()
                : connectionError;
        drawWrapped(canvas, detail, left, y + sp(76), right - left, 14, MUTED, 2);
        text(canvas, "正在自动重试", left, y + sp(128), 12, RED, true);
    }

    private void drawAttention(Canvas canvas, float left, float right, float y, MonitorSnapshot.Attention attention) {
        int color = "critical".equals(attention.severity) ? RED : AMBER;
        overline(canvas, "ATTENTION", left, y, color);
        textFit(canvas, attention.title, left, y + sp(45), right - left, 27, WHITE, true);
        if (!attention.detail.isBlank()) {
            drawWrapped(canvas, attention.detail, left, y + sp(78), right - left, 14, MUTED, 2);
        }
        String age = relativeTime(attention.occurredAt);
        if (!age.isBlank()) text(canvas, age, left, y + sp(132), 12, color, true);
    }

    private void drawCurrentJob(Canvas canvas, float left, float right, float y, MonitorSnapshot.Job job) {
        overline(canvas, "CURRENT", left, y, BLUE);
        textFit(canvas, readableOperation(job.operation), left, y + sp(45), right - left, 27, WHITE, true);
        text(canvas, statusLabel(job.status), left, y + sp(77), 14, BLUE, true);
        String duration = elapsed(job.startedAt);
        String heartbeat = relativeTime(job.heartbeatAt.isBlank() ? job.updatedAt : job.heartbeatAt);
        String meta = (duration.isBlank() ? "" : "已运行 " + duration)
                + (heartbeat.isBlank() ? "" : (duration.isBlank() ? "" : "  ·  ") + heartbeat + "更新");
        textFit(canvas, meta, left, y + sp(108), right - left, 12, MUTED, false);
        if (job.maxAttempts > 1) {
            text(canvas, "尝试 " + job.attempt + "/" + job.maxAttempts, left, y + sp(137), 11, MUTED, false);
        }
    }

    private void drawIdle(Canvas canvas, float left, float right, float y) {
        overline(canvas, "IDLE", left, y, GREEN);
        text(canvas, "当前没有活动任务", left, y + sp(45), 27, WHITE, true);
        if (snapshot != null && !snapshot.recent.isEmpty()) {
            MonitorSnapshot.Event recent = snapshot.recent.get(0);
            text(canvas, "最近", left, y + sp(82), 11, MUTED, true);
            textFit(canvas, recent.title, left, y + sp(111), right - left, 14, MUTED, false);
            text(canvas, relativeTime(recent.occurredAt), left, y + sp(137), 11, DIM, false);
        }
    }

    private void drawMetrics(Canvas canvas, float left, float right) {
        float y = getHeight() - dp(236);
        canvas.drawLine(left, y, right, y, linePaint);
        y += dp(38);

        int running = snapshot == null ? 0 : snapshot.runningWorkers;
        int queue = snapshot == null ? 0 : snapshot.queueDepth;
        int attentionCount = snapshot == null ? 0 : snapshot.attention.size();
        metric(canvas, "运行", String.valueOf(running), left, y, BLUE);
        metric(canvas, "队列", String.valueOf(queue), left + (right - left) / 3f, y, MUTED);
        metric(canvas, "待处理", String.valueOf(attentionCount), left + (right - left) * 2f / 3f, y,
                attentionCount > 0 ? AMBER : MUTED);

        y += dp(72);
        if (snapshot != null) {
            String disk = snapshot.host.diskUsedPercent < 0 ? "--" : snapshot.host.diskUsedPercent + "%";
            text(canvas, snapshot.host.name, left, y, 11, MUTED, true);
            textFit(canvas,
                    "负载 " + String.format(Locale.CHINA, "%.2f", snapshot.host.loadPerCpu)
                            + "  ·  内存 " + snapshot.host.memoryUsedPercent + "%"
                            + "  ·  磁盘 " + disk,
                    left, y + sp(23), right - left, 12, WHITE, false);
        } else {
            text(canvas, "Mac 指标不可用", left, y + sp(20), 12, DIM, false);
        }

        y += dp(58);
        if (deviceStatus != null) {
            String temperature = String.format(Locale.CHINA, "%.1f°C", deviceStatus.temperatureTenths / 10f);
            text(canvas, "K50", left, y, 11, MUTED, true);
            text(canvas,
                    deviceStatus.batteryPercent + "%"
                            + (deviceStatus.charging ? " 充电中" : "")
                            + "  ·  " + temperature
                            + "  ·  " + deviceStatus.network,
                    left, y + sp(23), 12, WHITE, false);
        }
    }

    private void drawDetail(Canvas canvas) {
        float left = dp(34);
        float right = getWidth() - dp(34);
        float y = dp(76);
        text(canvas, "实时详情", left, y, 25, WHITE, true);
        text(canvas, "轻触返回极简显示", right, y, 10, MUTED, false, Paint.Align.RIGHT);
        y += dp(44);
        canvas.drawLine(left, y, right, y, linePaint);
        y += dp(38);

        if (!configured || snapshot == null) {
            text(canvas, configured ? "尚未取得有效快照" : "尚未配置连接", left, y, 18, WHITE, true);
            drawWrapped(canvas, connectionError == null ? "长按屏幕配置连接。" : connectionError,
                    left, y + sp(34), right - left, 13, MUTED, 3);
            return;
        }

        text(canvas, "活动任务  " + snapshot.activeJobs.size(), left, y, 12, BLUE, true);
        y += dp(31);
        int shownJobs = Math.min(3, snapshot.activeJobs.size());
        if (shownJobs == 0) {
            text(canvas, "没有活动任务", left, y, 14, MUTED, false);
            y += dp(48);
        } else {
            for (int index = 0; index < shownJobs; index++) {
                MonitorSnapshot.Job job = snapshot.activeJobs.get(index);
                textFit(canvas, readableOperation(job.operation), left, y, right - left - dp(86), 15, WHITE, true);
                text(canvas, statusLabel(job.status), right, y, 11, statusColor(job.status), true, Paint.Align.RIGHT);
                textFit(canvas,
                        relativeTime(job.heartbeatAt.isBlank() ? job.updatedAt : job.heartbeatAt) + "更新"
                                + (job.maxAttempts > 1 ? "  ·  尝试 " + job.attempt + "/" + job.maxAttempts : ""),
                        left, y + sp(23), right - left, 11, MUTED, false);
                y += dp(62);
            }
        }

        canvas.drawLine(left, y, right, y, linePaint);
        y += dp(36);
        text(canvas, "最近事件", left, y, 12, MUTED, true);
        y += dp(31);
        int shownEvents = Math.min(5, snapshot.recent.size());
        if (shownEvents == 0) {
            text(canvas, "暂无最近事件", left, y, 14, DIM, false);
        } else {
            for (int index = 0; index < shownEvents && y < getHeight() - dp(80); index++) {
                MonitorSnapshot.Event event = snapshot.recent.get(index);
                dot(canvas, left + dp(4), y - dp(5), eventColor(event.tone), dp(3));
                textFit(canvas, event.title, left + dp(19), y, right - left - dp(92), 13, WHITE, false);
                text(canvas, relativeTime(event.occurredAt), right, y, 10, MUTED, false, Paint.Align.RIGHT);
                y += dp(44);
            }
        }

        text(canvas,
                "revision " + snapshot.revision + "  ·  " + lastDataDescription(),
                left, getHeight() - dp(28), 9, DIM, false);
    }

    private StateView stateView() {
        if (!configured) return new StateView(BLUE, "等待配置", "连接只读监控数据后开始显示");
        if (isOfflineOrStale()) return new StateView(RED, "连接离线", lastDataDescription());
        if (snapshot == null) return new StateView(RED, "连接离线", connectionError == null ? "正在连接" : connectionError);
        int color = stateColor(snapshot.state);
        return new StateView(color, snapshot.statusLabel, snapshot.statusDetail);
    }

    private boolean isOfflineOrStale() {
        if (!configured) return false;
        if (snapshot == null) return true;
        long sourceAt = snapshot.generatedAtMillis();
        long reference = sourceAt > 0 ? sourceAt : fetchedAt;
        return reference <= 0 || System.currentTimeMillis() - reference > 45_000L;
    }

    private String lastDataDescription() {
        if (snapshot == null || fetchedAt <= 0) return connectionError == null ? "尚未收到数据" : connectionError;
        long seconds = Math.max(0L, (System.currentTimeMillis() - fetchedAt) / 1000L);
        if (seconds < 60) return "最后数据 " + seconds + " 秒前";
        return "最后数据 " + (seconds / 60) + " 分钟前";
    }

    private static String readableOperation(String operation) {
        if (operation == null || operation.isBlank()) return "未命名任务";
        String normalized = operation.replace('_', ' ').replace('-', ' ').trim();
        if ("repository command execute".equalsIgnoreCase(normalized)) return "仓库命令执行";
        if ("dispatch task".equalsIgnoreCase(normalized)) return "任务执行";
        if ("run check".equalsIgnoreCase(normalized)) return "运行检查";
        return normalized;
    }

    private static String statusLabel(String status) {
        switch (status) {
            case "running": return "正在执行";
            case "dispatched": return "已派发";
            case "queued": return "排队中";
            case "waiting_for_dependency": return "等待依赖";
            case "waiting_for_workspace": return "等待工作区";
            case "waiting_for_heavy_check": return "等待检查";
            case "waiting_for_integration": return "等待集成";
            case "waiting_for_release_barrier": return "等待发布";
            case "waiting_for_approval": return "等待确认";
            case "human_attention_required": return "需要处理";
            case "stale": return "心跳过期";
            default: return status == null || status.isBlank() ? "状态未知" : status;
        }
    }

    private static int statusColor(String status) {
        if ("human_attention_required".equals(status) || "stale".equals(status)) return AMBER;
        if (status != null && status.startsWith("waiting_")) return AMBER;
        return BLUE;
    }

    private static int eventColor(String tone) {
        if ("success".equals(tone)) return GREEN;
        if ("warning".equals(tone)) return AMBER;
        if ("error".equals(tone)) return RED;
        return BLUE;
    }

    private static int stateColor(String state) {
        if ("healthy".equals(state)) return GREEN;
        if ("degraded".equals(state)) return AMBER;
        if ("attention".equals(state)) return RED;
        return RED;
    }

    private static String elapsed(String iso) {
        try {
            if (iso == null || iso.isBlank()) return "";
            long seconds = Math.max(0L, Duration.between(Instant.parse(iso), Instant.now()).getSeconds());
            if (seconds < 60) return seconds + "秒";
            if (seconds < 3600) return (seconds / 60) + "分" + (seconds % 60) + "秒";
            return (seconds / 3600) + "小时" + ((seconds % 3600) / 60) + "分";
        } catch (RuntimeException ignored) {
            return "";
        }
    }

    private static String relativeTime(String iso) {
        try {
            if (iso == null || iso.isBlank()) return "";
            long seconds = Math.max(0L, Duration.between(Instant.parse(iso), Instant.now()).getSeconds());
            if (seconds < 10) return "刚刚";
            if (seconds < 60) return seconds + "秒前";
            if (seconds < 3600) return (seconds / 60) + "分钟前";
            if (seconds < 86_400) return (seconds / 3600) + "小时前";
            return (seconds / 86_400) + "天前";
        } catch (RuntimeException ignored) {
            return "";
        }
    }

    private void metric(Canvas canvas, String label, String value, float x, float y, int color) {
        text(canvas, value, x, y, 24, color, true);
        text(canvas, label, x, y + sp(23), 10, MUTED, false);
    }

    private void overline(Canvas canvas, String value, float x, float y, int color) {
        text(canvas, value, x, y, 10, color, true);
    }

    private void drawWrapped(Canvas canvas, String value, float x, float firstBaseline, float maxWidth,
                             float sizeSp, int color, int maxLines) {
        if (value == null || value.isBlank()) return;
        String remaining = value.trim();
        float baseline = firstBaseline;
        for (int line = 0; line < maxLines && !remaining.isEmpty(); line++) {
            int end = remaining.length();
            paint.setTextSize(sp(sizeSp));
            paint.setTypeface(Typeface.create("sans", Typeface.NORMAL));
            while (end > 1 && paint.measureText(remaining.substring(0, end)) > maxWidth) end--;
            if (end < remaining.length()) {
                int breakAt = Math.max(remaining.lastIndexOf(' ', end), remaining.lastIndexOf('，', end));
                if (breakAt > end / 2) end = breakAt + 1;
            }
            String current = remaining.substring(0, end).trim();
            remaining = remaining.substring(end).trim();
            if (line == maxLines - 1 && !remaining.isEmpty()) current = trimToWidth(current + "…", maxWidth, sizeSp);
            text(canvas, current, x, baseline, sizeSp, color, false);
            baseline += sp(sizeSp + 7);
        }
    }

    private void textFit(Canvas canvas, String value, float x, float baseline, float maxWidth,
                         float sizeSp, int color, boolean bold) {
        text(canvas, trimToWidth(value, maxWidth, sizeSp), x, baseline, sizeSp, color, bold);
    }

    private String trimToWidth(String value, float maxWidth, float sizeSp) {
        if (value == null) return "";
        paint.setTextSize(sp(sizeSp));
        String result = value;
        while (result.length() > 1 && paint.measureText(result) > maxWidth) result = result.substring(0, result.length() - 1);
        if (!result.equals(value) && result.length() > 1) result = result.substring(0, result.length() - 1) + "…";
        return result;
    }

    private void text(Canvas canvas, String value, float x, float baseline, float sizeSp,
                      int color, boolean bold) {
        text(canvas, value, x, baseline, sizeSp, color, bold, Paint.Align.LEFT);
    }

    private void text(Canvas canvas, String value, float x, float baseline, float sizeSp,
                      int color, boolean bold, Paint.Align align) {
        paint.setColor(color);
        paint.setTextSize(sp(sizeSp));
        paint.setTextAlign(align);
        paint.setTypeface(Typeface.create("sans", bold ? Typeface.BOLD : Typeface.NORMAL));
        canvas.drawText(value == null ? "" : value, x, baseline, paint);
    }

    private void dot(Canvas canvas, float x, float y, int color, float radius) {
        paint.setColor(color);
        paint.setStyle(Paint.Style.FILL);
        canvas.drawCircle(x, y, radius, paint);
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        if (event.getAction() == MotionEvent.ACTION_DOWN) {
            touchDownAt = SystemClock.elapsedRealtime();
            touchDownX = event.getX();
            touchDownY = event.getY();
            return true;
        }
        if (event.getAction() == MotionEvent.ACTION_UP) {
            long held = SystemClock.elapsedRealtime() - touchDownAt;
            float distance = Math.abs(event.getX() - touchDownX) + Math.abs(event.getY() - touchDownY);
            if (held >= 650L && distance < dp(30)) {
                if (actions != null) actions.openConfiguration();
                return true;
            }
            detailVisible = !detailVisible;
            if (actions != null) actions.onDetailVisibilityChanged(detailVisible);
            invalidate();
            return true;
        }
        return true;
    }

    private float dp(float value) {
        return value * density;
    }

    private float sp(float value) {
        return value * scaledDensity;
    }

    private static final class StateView {
        final int color;
        final String label;
        final String detail;

        StateView(int color, String label, String detail) {
            this.color = color;
            this.label = label;
            this.detail = detail;
        }
    }
}
