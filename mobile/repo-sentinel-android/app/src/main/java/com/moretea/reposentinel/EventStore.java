package com.moretea.reposentinel;

import android.content.Context;
import android.content.Intent;
import android.util.Base64;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class EventStore {
    public static final String ACTION_EVENTS_CHANGED = "com.moretea.reposentinel.EVENTS_CHANGED";
    private static final String FILE_NAME = "sentinel-events.log";
    private static final int MAX_STORED = 250;

    private EventStore() {}

    public static synchronized void append(Context context, String type, String message, String severity) {
        long now = System.currentTimeMillis();
        String line = now + "|" + safe(severity) + "|" + safe(type) + "|" + encode(message) + "\n";
        File file = new File(context.getFilesDir(), FILE_NAME);
        try (FileOutputStream output = new FileOutputStream(file, true)) {
            output.write(line.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            return;
        }
        trim(context, file);
        context.sendBroadcast(new Intent(ACTION_EVENTS_CHANGED).setPackage(context.getPackageName()));
    }

    public static synchronized List<Event> readRecent(Context context, int limit) {
        File file = new File(context.getFilesDir(), FILE_NAME);
        if (!file.exists()) return Collections.emptyList();
        ArrayList<Event> all = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                Event event = parse(line);
                if (event != null) all.add(event);
            }
        } catch (Exception ignored) {
            return Collections.emptyList();
        }
        Collections.reverse(all);
        if (all.size() <= limit) return all;
        return new ArrayList<>(all.subList(0, limit));
    }

    private static void trim(Context context, File file) {
        List<Event> events = readRecent(context, MAX_STORED + 50);
        if (events.size() <= MAX_STORED) return;
        Collections.reverse(events);
        int start = Math.max(0, events.size() - MAX_STORED);
        try (FileOutputStream output = new FileOutputStream(file, false)) {
            for (int i = start; i < events.size(); i++) {
                Event event = events.get(i);
                String line = event.timestamp + "|" + safe(event.severity) + "|" + safe(event.type)
                        + "|" + encode(event.message) + "\n";
                output.write(line.getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
            // Keeping an oversized local history is safer than losing it on trim failure.
        }
    }

    private static Event parse(String line) {
        String[] parts = line.split("\\|", 4);
        if (parts.length != 4) return null;
        try {
            return new Event(Long.parseLong(parts[0]), parts[2], decode(parts[3]), parts[1]);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value.replace("|", "_").replace("\n", " ");
    }

    private static String encode(String value) {
        return Base64.encodeToString((value == null ? "" : value).getBytes(StandardCharsets.UTF_8),
                Base64.NO_WRAP | Base64.URL_SAFE);
    }

    private static String decode(String value) {
        return new String(Base64.decode(value, Base64.NO_WRAP | Base64.URL_SAFE), StandardCharsets.UTF_8);
    }

    public static final class Event {
        public final long timestamp;
        public final String type;
        public final String message;
        public final String severity;

        Event(long timestamp, String type, String message, String severity) {
            this.timestamp = timestamp;
            this.type = type;
            this.message = message;
            this.severity = severity;
        }
    }
}
