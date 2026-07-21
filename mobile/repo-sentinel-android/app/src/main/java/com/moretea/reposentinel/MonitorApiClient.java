package com.moretea.reposentinel;

import org.json.JSONObject;

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

public final class MonitorApiClient {
    private static final String SNAPSHOT_PATH = "/mobile/v1/monitor/snapshot";

    private MonitorApiClient() {}

    public static Result fetchSnapshot(String endpoint, String deviceId, String token) {
        if (endpoint == null || !(endpoint.startsWith("http://") || endpoint.startsWith("https://"))) {
            return Result.error("需要配置 Mac 监控地址");
        }
        if (deviceId == null || deviceId.isBlank()) return Result.error("设备 ID 未配置");
        if (token == null || token.isBlank()) return Result.error("设备令牌未配置");

        String rawBody = "{}";
        HttpURLConnection connection = null;
        try {
            String timestamp = Instant.now().toString();
            String nonce = UUID.randomUUID().toString().replace("-", "");
            String signature = hmacHex(token, timestamp + "." + nonce + "." + rawBody);
            byte[] body = rawBody.getBytes(StandardCharsets.UTF_8);
            String base = normalizeBaseEndpoint(endpoint);

            connection = (HttpURLConnection) new URL(base + SNAPSHOT_PATH).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(4_000);
            connection.setReadTimeout(8_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("content-type", "application/json; charset=utf-8");
            connection.setRequestProperty("accept", "application/json");
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
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String response = readBounded(input, 131_072);
            if (status < 200 || status >= 300) {
                return Result.error(errorMessage(status, response));
            }
            return Result.success(MonitorSnapshot.parse(response), status, response);
        } catch (Exception error) {
            String message = error.getMessage();
            return Result.error(error.getClass().getSimpleName() + (message == null || message.isBlank() ? "" : ": " + message));
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    public static String normalizeBaseEndpoint(String endpoint) {
        String value = endpoint == null ? "" : endpoint.trim();
        int mobilePath = value.indexOf("/mobile/");
        if (mobilePath >= 0) value = value.substring(0, mobilePath);
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }

    private static String errorMessage(int status, String body) {
        try {
            String message = new JSONObject(body).optString("error", "").trim();
            if (!message.isEmpty()) return "HTTP " + status + " · " + message;
        } catch (Exception ignored) {}
        return "HTTP " + status + (body == null || body.isBlank() ? "" : " · " + body.trim());
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
        public final MonitorSnapshot snapshot;
        public final int status;
        public final String rawBody;
        public final String error;

        private Result(MonitorSnapshot snapshot, int status, String rawBody, String error) {
            this.snapshot = snapshot;
            this.status = status;
            this.rawBody = rawBody;
            this.error = error;
        }

        static Result success(MonitorSnapshot snapshot, int status, String rawBody) {
            return new Result(snapshot, status, rawBody, null);
        }

        static Result error(String message) {
            return new Result(null, 0, "", message == null ? "连接失败" : message);
        }

        public boolean ok() {
            return snapshot != null && error == null;
        }
    }
}
