package com.moretea.reposentinel;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.UUID;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class MobileIntentClient {
    private MobileIntentClient() {}

    public static Result post(String endpoint, String deviceId, String token, String rawJson) {
        if (endpoint == null || !(endpoint.startsWith("http://") || endpoint.startsWith("https://"))) {
            return Result.error("请输入完整的 http:// 或 https:// 移动接口地址");
        }
        if (deviceId == null || deviceId.isBlank()) return Result.error("设备 ID 不能为空");
        if (token == null || token.isBlank()) return Result.error("设备令牌不能为空");
        if (rawJson == null || rawJson.isBlank()) return Result.error("请求 JSON 不能为空");

        HttpURLConnection connection = null;
        try {
            String timestamp = Instant.now().toString();
            String nonce = UUID.randomUUID().toString().replace("-", "");
            String signature = hmacHex(token, timestamp + "." + nonce + "." + rawJson);
            byte[] body = rawJson.getBytes(StandardCharsets.UTF_8);

            connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(3500);
            connection.setReadTimeout(7000);
            connection.setDoOutput(true);
            connection.setRequestProperty("content-type", "application/json; charset=utf-8");
            connection.setRequestProperty("authorization", "Bearer " + token);
            connection.setRequestProperty("x-repo-harness-device-id", deviceId);
            connection.setRequestProperty("x-repo-harness-timestamp", timestamp);
            connection.setRequestProperty("x-repo-harness-nonce", nonce);
            connection.setRequestProperty("x-repo-harness-signature", signature);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }

            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String response = readBounded(stream, 32768);
            return new Result(status, response, status >= 200 && status < 300, null);
        } catch (Exception error) {
            return Result.error(error.getClass().getSimpleName() + ": " + error.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readBounded(InputStream input, int maxChars) throws Exception {
        if (input == null) return "";
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            char[] buffer = new char[2048];
            int read;
            while ((read = reader.read(buffer)) >= 0 && result.length() < maxChars) {
                int allowed = Math.min(read, maxChars - result.length());
                result.append(buffer, 0, allowed);
            }
        }
        return result.toString();
    }

    private static String hmacHex(String key, String value) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] bytes = mac.doFinal(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) result.append(String.format("%02x", item));
        return result.toString();
    }

    public static final class Result {
        public final int status;
        public final String body;
        public final boolean ok;
        public final String error;

        Result(int status, String body, boolean ok, String error) {
            this.status = status;
            this.body = body;
            this.ok = ok;
            this.error = error;
        }

        static Result error(String message) {
            return new Result(0, "", false, message);
        }
    }
}
