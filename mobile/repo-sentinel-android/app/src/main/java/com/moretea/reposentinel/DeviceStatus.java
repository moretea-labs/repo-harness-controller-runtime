package com.moretea.reposentinel;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;

public final class DeviceStatus {
    private DeviceStatus() {}

    public static Snapshot collect(Context context) {
        int batteryPercent = 0;
        int temperatureTenths = 0;
        boolean charging = false;
        Intent battery = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (battery != null) {
            int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, 0);
            int scale = Math.max(1, battery.getIntExtra(BatteryManager.EXTRA_SCALE, 100));
            batteryPercent = Math.round(level * 100f / scale);
            temperatureTenths = battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0);
            charging = battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0;
        }
        return new Snapshot(batteryPercent, temperatureTenths, charging, network(context));
    }

    private static String network(Context context) {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return "离线";
        Network network = manager.getActiveNetwork();
        if (network == null) return "离线";
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
        if (capabilities == null) return "已连接";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "Wi‑Fi";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "移动网络";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "以太网";
        return "已连接";
    }

    public static final class Snapshot {
        public final int batteryPercent;
        public final int temperatureTenths;
        public final boolean charging;
        public final String network;

        Snapshot(int batteryPercent, int temperatureTenths, boolean charging, String network) {
            this.batteryPercent = batteryPercent;
            this.temperatureTenths = temperatureTenths;
            this.charging = charging;
            this.network = network;
        }
    }
}
