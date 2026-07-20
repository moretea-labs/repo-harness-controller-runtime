package com.moretea.reposentinel;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

public class SentinelService extends Service implements SensorEventListener {
    public static final String ACTION_STOP = "com.moretea.reposentinel.STOP_SENTINEL";
    public static final String ACTION_STATE_CHANGED = "com.moretea.reposentinel.SENTINEL_STATE_CHANGED";
    private static final String CHANNEL_ID = "repo-sentinel-node";
    private static final int NOTIFICATION_ID = 6101;
    private static final String PREFS = "repo-sentinel-runtime";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable heartbeat = new Runnable() {
        @Override public void run() {
            long now = System.currentTimeMillis();
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putLong("last_heartbeat", now).apply();
            handler.postDelayed(this, 30_000L);
        }
    };

    private SensorManager sensorManager;
    private long lastMotionAt;
    private long lastLightAt;
    private float lastLux = -1f;

    public static boolean isRunning(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("sentinel_running", false);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        sensorManager = (SensorManager) getSystemService(SENSOR_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelfSafely();
            return START_NOT_STICKY;
        }
        startForeground(NOTIFICATION_ID, buildNotification("运动与环境光监测中"));
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putBoolean("sentinel_running", true)
                .putLong("last_heartbeat", System.currentTimeMillis())
                .apply();
        registerSensors();
        handler.removeCallbacks(heartbeat);
        handler.post(heartbeat);
        EventStore.append(this, "sentinel_started", "哨兵模式已启动，正在监测设备移动与环境光变化", "success");
        sendBroadcast(new Intent(ACTION_STATE_CHANGED).setPackage(getPackageName()));
        return START_STICKY;
    }

    private void registerSensors() {
        if (sensorManager == null) return;
        Sensor accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        Sensor light = sensorManager.getDefaultSensor(Sensor.TYPE_LIGHT);
        if (accelerometer != null) {
            sensorManager.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_NORMAL);
        }
        if (light != null) {
            sensorManager.registerListener(this, light, SensorManager.SENSOR_DELAY_NORMAL);
        }
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event == null || event.sensor == null) return;
        long now = System.currentTimeMillis();
        if (event.sensor.getType() == Sensor.TYPE_ACCELEROMETER && event.values.length >= 3) {
            double magnitude = Math.sqrt(event.values[0] * event.values[0]
                    + event.values[1] * event.values[1] + event.values[2] * event.values[2]);
            if (magnitude > 14.5 && now - lastMotionAt > 8_000L) {
                lastMotionAt = now;
                EventStore.append(this, "device_motion",
                        "检测到手机或支架发生明显移动，强度 " + String.format("%.1f", magnitude), "warning");
            }
        } else if (event.sensor.getType() == Sensor.TYPE_LIGHT && event.values.length >= 1) {
            float lux = event.values[0];
            if (lastLux >= 0 && Math.abs(lux - lastLux) > 250f && now - lastLightAt > 12_000L) {
                lastLightAt = now;
                EventStore.append(this, "light_changed",
                        "环境光发生明显变化：" + Math.round(lastLux) + " → " + Math.round(lux) + " lux", "info");
            }
            lastLux = lux;
        }
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    private Notification buildNotification(String text) {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent open = PendingIntent.getActivity(this, 1, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stopIntent = new Intent(this, SentinelService.class).setAction(ACTION_STOP);
        PendingIntent stop = PendingIntent.getService(this, 2, stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(com.moretea.reposentinel.R.drawable.ic_sentinel)
                .setContentTitle("Repo Sentinel 正在运行")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(null, "停止", stop).build())
                .build();
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Repo Sentinel 节点",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("显示 Repo Sentinel 哨兵模式和设备节点状态");
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private void stopSelfSafely() {
        handler.removeCallbacksAndMessages(null);
        if (sensorManager != null) sensorManager.unregisterListener(this);
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("sentinel_running", false).apply();
        EventStore.append(this, "sentinel_stopped", "哨兵模式已停止", "info");
        sendBroadcast(new Intent(ACTION_STATE_CHANGED).setPackage(getPackageName()));
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (sensorManager != null) sensorManager.unregisterListener(this);
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("sentinel_running", false).apply();
        sendBroadcast(new Intent(ACTION_STATE_CHANGED).setPackage(getPackageName()));
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
