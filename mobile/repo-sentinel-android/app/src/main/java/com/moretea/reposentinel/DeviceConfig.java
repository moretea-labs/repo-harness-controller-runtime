package com.moretea.reposentinel;

import android.content.Context;
import android.content.SharedPreferences;

public final class DeviceConfig {
    private static final String PREFS = "repo-sentinel";
    private static final String KEY_ENDPOINT = "controller_endpoint";
    private static final String KEY_DEVICE_ID = "device_id";
    private static final String KEY_TOKEN = "device_token";

    private DeviceConfig() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static String endpoint(Context context) {
        return prefs(context).getString(KEY_ENDPOINT, "");
    }

    public static String deviceId(Context context) {
        return prefs(context).getString(KEY_DEVICE_ID, "redmi-k50");
    }

    public static String token(Context context) {
        return prefs(context).getString(KEY_TOKEN, "");
    }

    public static void save(Context context, String endpoint, String deviceId, String token) {
        prefs(context).edit()
                .putString(KEY_ENDPOINT, endpoint == null ? "" : endpoint.trim())
                .putString(KEY_DEVICE_ID, deviceId == null ? "" : deviceId.trim())
                .putString(KEY_TOKEN, token == null ? "" : token.trim())
                .apply();
    }
}
