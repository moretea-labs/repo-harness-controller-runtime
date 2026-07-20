package com.moretea.reposentinel;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public class RepoAccessibilityService extends AccessibilityService {
    private static volatile RepoAccessibilityService instance;
    private long lastWindowEventAt;

    public static boolean isConnected() {
        return instance != null;
    }

    @Override
    protected void onServiceConnected() {
        instance = this;
        EventStore.append(this, "agent_connected", "Accessibility 执行代理已连接", "success");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || event.getPackageName() == null) return;
        if (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        long now = System.currentTimeMillis();
        if (now - lastWindowEventAt < 800) return;
        lastWindowEventAt = now;
        getSharedPreferences("repo-sentinel-runtime", MODE_PRIVATE).edit()
                .putString("foreground_package", event.getPackageName().toString())
                .putLong("foreground_changed_at", now)
                .apply();
    }

    @Override
    public void onInterrupt() {
        EventStore.append(this, "agent_interrupted", "Accessibility 执行代理被系统中断", "warning");
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        EventStore.append(this, "agent_disconnected", "Accessibility 执行代理已断开", "warning");
        super.onDestroy();
    }

    public static String snapshot() {
        RepoAccessibilityService service = instance;
        if (service == null) return "执行代理尚未启用";
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) return "当前页面未提供可访问性节点";
        ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        StringBuilder result = new StringBuilder();
        int count = 0;
        while (!queue.isEmpty() && count < 80 && result.length() < 12000) {
            AccessibilityNodeInfo node = queue.removeFirst();
            count++;
            Rect bounds = new Rect();
            node.getBoundsInScreen(bounds);
            String text = node.isPassword() ? "<redacted>" : value(node.getText());
            String desc = node.isPassword() ? "<redacted>" : value(node.getContentDescription());
            result.append(count).append('.').append(' ')
                    .append(value(node.getClassName()))
                    .append(" text=").append(compact(text))
                    .append(" desc=").append(compact(desc))
                    .append(" id=").append(compact(node.getViewIdResourceName()))
                    .append(" bounds=").append(bounds.toShortString())
                    .append(" clickable=").append(node.isClickable())
                    .append('\n');
            for (int i = 0; i < node.getChildCount(); i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) queue.addLast(child);
            }
        }
        String summary = result.toString();
        EventStore.append(service, "ui_snapshot", "已读取当前页面 " + count + " 个节点", "info");
        return summary;
    }

    public static boolean clickText(String target) {
        RepoAccessibilityService service = instance;
        if (service == null || target == null || target.trim().isEmpty()) return false;
        if (isSensitive(target)) {
            EventStore.append(service, "action_blocked", "已阻止敏感控件操作：" + target, "warning");
            return false;
        }
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) return false;
        AccessibilityNodeInfo match = find(root, target.trim());
        if (match == null) {
            EventStore.append(service, "action_failed", "未找到控件：" + target, "warning");
            return false;
        }
        AccessibilityNodeInfo clickable = match;
        while (clickable != null && !clickable.isClickable()) clickable = clickable.getParent();
        boolean ok = clickable != null && clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        EventStore.append(service, ok ? "action_clicked" : "action_failed",
                (ok ? "已点击：" : "控件不可点击：") + target, ok ? "success" : "warning");
        return ok;
    }

    public static boolean setText(String target, String input) {
        RepoAccessibilityService service = instance;
        if (service == null || isSensitive(target) || isSensitive(input)) return false;
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        AccessibilityNodeInfo match = root == null ? null : find(root, target);
        if (match == null || match.isPassword() || !match.isEditable()) return false;
        Bundle arguments = new Bundle();
        arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, input);
        return match.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
    }

    public static boolean back() {
        return instance != null && instance.performGlobalAction(GLOBAL_ACTION_BACK);
    }

    public static boolean home() {
        return instance != null && instance.performGlobalAction(GLOBAL_ACTION_HOME);
    }

    public static boolean swipe(float startX, float startY, float endX, float endY, long durationMs) {
        RepoAccessibilityService service = instance;
        if (service == null) return false;
        Path path = new Path();
        path.moveTo(startX, startY);
        path.lineTo(endX, endY);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, Math.max(100, durationMs)))
                .build();
        return service.dispatchGesture(gesture, null, null);
    }

    private static AccessibilityNodeInfo find(AccessibilityNodeInfo root, String target) {
        String needle = target.toLowerCase(Locale.ROOT);
        List<AccessibilityNodeInfo> contains = new ArrayList<>();
        ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        int count = 0;
        while (!queue.isEmpty() && count++ < 500) {
            AccessibilityNodeInfo node = queue.removeFirst();
            String text = value(node.getText()).toLowerCase(Locale.ROOT);
            String desc = value(node.getContentDescription()).toLowerCase(Locale.ROOT);
            String id = value(node.getViewIdResourceName()).toLowerCase(Locale.ROOT);
            if (text.equals(needle) || desc.equals(needle) || id.equals(needle)) return node;
            if (text.contains(needle) || desc.contains(needle) || id.contains(needle)) contains.add(node);
            for (int i = 0; i < node.getChildCount(); i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) queue.addLast(child);
            }
        }
        return contains.isEmpty() ? null : contains.get(0);
    }

    private static boolean isSensitive(String value) {
        if (value == null) return false;
        String normalized = value.toLowerCase(Locale.ROOT);
        String[] blocked = {"密码", "验证码", "支付", "付款", "购买", "下单", "提交订单", "确认订单",
                "生物识别", "指纹确认", "password", "verification code", "captcha", "payment", "checkout", "purchase"};
        for (String keyword : blocked) if (normalized.contains(keyword)) return true;
        return false;
    }

    private static String value(CharSequence value) {
        return value == null ? "" : value.toString();
    }

    private static String compact(String value) {
        if (value == null || value.isEmpty()) return "-";
        String normalized = value.replace('\n', ' ').replace('\r', ' ');
        return normalized.length() > 80 ? normalized.substring(0, 80) + "…" : normalized;
    }
}
