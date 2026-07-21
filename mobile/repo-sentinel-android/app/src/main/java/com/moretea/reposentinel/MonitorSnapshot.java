package com.moretea.reposentinel;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class MonitorSnapshot {
    public final String generatedAt;
    public final long revision;
    public final String state;
    public final String statusLabel;
    public final String statusDetail;
    public final String repositoryName;
    public final int queueDepth;
    public final int runningWorkers;
    public final int activeLeases;
    public final List<Job> activeJobs;
    public final List<Attention> attention;
    public final List<Event> recent;
    public final Host host;
    public final long pollAfterMs;

    private MonitorSnapshot(
            String generatedAt,
            long revision,
            String state,
            String statusLabel,
            String statusDetail,
            String repositoryName,
            int queueDepth,
            int runningWorkers,
            int activeLeases,
            List<Job> activeJobs,
            List<Attention> attention,
            List<Event> recent,
            Host host,
            long pollAfterMs) {
        this.generatedAt = generatedAt;
        this.revision = revision;
        this.state = state;
        this.statusLabel = statusLabel;
        this.statusDetail = statusDetail;
        this.repositoryName = repositoryName;
        this.queueDepth = queueDepth;
        this.runningWorkers = runningWorkers;
        this.activeLeases = activeLeases;
        this.activeJobs = Collections.unmodifiableList(activeJobs);
        this.attention = Collections.unmodifiableList(attention);
        this.recent = Collections.unmodifiableList(recent);
        this.host = host;
        this.pollAfterMs = Math.max(5_000L, Math.min(30_000L, pollAfterMs));
    }

    public static MonitorSnapshot parse(String raw) throws JSONException {
        JSONObject root = new JSONObject(raw);
        JSONObject repository = root.optJSONObject("repository");
        JSONObject execution = root.optJSONObject("execution");
        JSONObject hostJson = root.optJSONObject("host");

        List<Job> jobs = new ArrayList<>();
        JSONArray jobArray = execution == null ? null : execution.optJSONArray("activeJobs");
        if (jobArray != null) {
            for (int index = 0; index < jobArray.length(); index++) {
                JSONObject item = jobArray.optJSONObject(index);
                if (item == null) continue;
                jobs.add(new Job(
                        text(item, "jobId", ""),
                        text(item, "operation", text(item, "type", "任务")),
                        text(item, "type", ""),
                        text(item, "status", "unknown"),
                        text(item, "priority", ""),
                        text(item, "startedAt", ""),
                        text(item, "updatedAt", ""),
                        text(item, "heartbeatAt", ""),
                        item.optInt("attempt", 1),
                        item.optInt("maxAttempts", 1)));
            }
        }

        List<Attention> attention = new ArrayList<>();
        JSONArray attentionArray = root.optJSONArray("attention");
        if (attentionArray != null) {
            for (int index = 0; index < attentionArray.length(); index++) {
                JSONObject item = attentionArray.optJSONObject(index);
                if (item == null) continue;
                attention.add(new Attention(
                        text(item, "id", ""),
                        text(item, "severity", "warning"),
                        text(item, "title", "需要处理"),
                        text(item, "detail", ""),
                        text(item, "occurredAt", "")));
            }
        }

        List<Event> events = new ArrayList<>();
        JSONArray eventArray = root.optJSONArray("recent");
        if (eventArray != null) {
            for (int index = 0; index < eventArray.length(); index++) {
                JSONObject item = eventArray.optJSONObject(index);
                if (item == null) continue;
                events.add(new Event(
                        text(item, "id", ""),
                        text(item, "tone", "info"),
                        text(item, "title", "状态更新"),
                        text(item, "occurredAt", "")));
            }
        }

        Host host = new Host(
                hostJson == null ? "Mac" : text(hostJson, "name", "Mac"),
                hostJson == null ? 0d : hostJson.optDouble("loadPerCpu", 0d),
                hostJson == null ? 0 : hostJson.optInt("memoryUsedPercent", 0),
                hostJson == null || hostJson.isNull("diskUsedPercent") ? -1 : hostJson.optInt("diskUsedPercent", -1),
                hostJson == null ? 0L : hostJson.optLong("uptimeSeconds", 0L));

        return new MonitorSnapshot(
                text(root, "generatedAt", ""),
                root.optLong("revision", 0L),
                text(root, "state", "offline"),
                text(root, "statusLabel", "状态未知"),
                text(root, "statusDetail", ""),
                repository == null ? "repo-harness" : text(repository, "name", "repo-harness"),
                execution == null ? 0 : execution.optInt("queueDepth", 0),
                execution == null ? 0 : execution.optInt("runningWorkers", 0),
                execution == null ? 0 : execution.optInt("activeLeases", 0),
                jobs,
                attention,
                events,
                host,
                root.optLong("pollAfterMs", 15_000L));
    }

    public long generatedAtMillis() {
        try {
            return generatedAt.isEmpty() ? 0L : Instant.parse(generatedAt).toEpochMilli();
        } catch (RuntimeException ignored) {
            return 0L;
        }
    }

    private static String text(JSONObject object, String key, String fallback) {
        String value = object.optString(key, fallback);
        return value == null ? fallback : value.trim();
    }

    public static final class Job {
        public final String jobId;
        public final String operation;
        public final String type;
        public final String status;
        public final String priority;
        public final String startedAt;
        public final String updatedAt;
        public final String heartbeatAt;
        public final int attempt;
        public final int maxAttempts;

        Job(String jobId, String operation, String type, String status, String priority,
            String startedAt, String updatedAt, String heartbeatAt, int attempt, int maxAttempts) {
            this.jobId = jobId;
            this.operation = operation;
            this.type = type;
            this.status = status;
            this.priority = priority;
            this.startedAt = startedAt;
            this.updatedAt = updatedAt;
            this.heartbeatAt = heartbeatAt;
            this.attempt = attempt;
            this.maxAttempts = maxAttempts;
        }
    }

    public static final class Attention {
        public final String id;
        public final String severity;
        public final String title;
        public final String detail;
        public final String occurredAt;

        Attention(String id, String severity, String title, String detail, String occurredAt) {
            this.id = id;
            this.severity = severity;
            this.title = title;
            this.detail = detail;
            this.occurredAt = occurredAt;
        }
    }

    public static final class Event {
        public final String id;
        public final String tone;
        public final String title;
        public final String occurredAt;

        Event(String id, String tone, String title, String occurredAt) {
            this.id = id;
            this.tone = tone;
            this.title = title;
            this.occurredAt = occurredAt;
        }
    }

    public static final class Host {
        public final String name;
        public final double loadPerCpu;
        public final int memoryUsedPercent;
        public final int diskUsedPercent;
        public final long uptimeSeconds;

        Host(String name, double loadPerCpu, int memoryUsedPercent, int diskUsedPercent, long uptimeSeconds) {
            this.name = name;
            this.loadPerCpu = loadPerCpu;
            this.memoryUsedPercent = memoryUsedPercent;
            this.diskUsedPercent = diskUsedPercent;
            this.uptimeSeconds = uptimeSeconds;
        }
    }
}
