package io.github.yannisyoussef.qe.report.protocol.internal;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.github.yannisyoussef.qe.report.protocol.AttachmentAdded;
import io.github.yannisyoussef.qe.report.protocol.AttemptFinished;
import io.github.yannisyoussef.qe.report.protocol.AttemptStarted;
import io.github.yannisyoussef.qe.report.protocol.Component;
import io.github.yannisyoussef.qe.report.protocol.Event;
import io.github.yannisyoussef.qe.report.protocol.EventTypes;
import io.github.yannisyoussef.qe.report.protocol.Executor;
import io.github.yannisyoussef.qe.report.protocol.ExpectedStatus;
import io.github.yannisyoussef.qe.report.protocol.Failure;
import io.github.yannisyoussef.qe.report.protocol.FailurePhase;
import io.github.yannisyoussef.qe.report.protocol.HistoricalIdStability;
import io.github.yannisyoussef.qe.report.protocol.Location;
import io.github.yannisyoussef.qe.report.protocol.PathSegment;
import io.github.yannisyoussef.qe.report.protocol.Payload;
import io.github.yannisyoussef.qe.report.protocol.ProtocolException;
import io.github.yannisyoussef.qe.report.protocol.ProtocolException.Reason;
import io.github.yannisyoussef.qe.report.protocol.ProtocolVersion;
import io.github.yannisyoussef.qe.report.protocol.RunFinished;
import io.github.yannisyoussef.qe.report.protocol.ScopeFailed;
import io.github.yannisyoussef.qe.report.protocol.SessionFinished;
import io.github.yannisyoussef.qe.report.protocol.SessionStarted;
import io.github.yannisyoussef.qe.report.protocol.Source;
import io.github.yannisyoussef.qe.report.protocol.Status;
import io.github.yannisyoussef.qe.report.protocol.StepFinished;
import io.github.yannisyoussef.qe.report.protocol.StepStarted;
import io.github.yannisyoussef.qe.report.protocol.TestCase;
import io.github.yannisyoussef.qe.report.protocol.UnknownPayload;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/** Tree-based Jackson codec. Field order on write is fixed so output is deterministic. */
public final class JsonCodec {
  private static final JsonMapper MAPPER = JsonMapper.builder().build();
  private static final JsonNodeFactory F = JsonNodeFactory.instance;
  private static final Pattern IDENTIFIER = Pattern.compile("^[\\x21-\\x7E]+$");
  private static final Pattern EVENT_TYPE =
      Pattern.compile("^[a-z][a-zA-Z0-9]*(\\.[a-z][a-zA-Z0-9]*)+$");
  private static final Pattern TIMESTAMP =
      Pattern.compile(
          "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$");

  private JsonCodec() {}

  // ---------------------------------------------------------------- read

  public static Event read(String json) {
    JsonNode root;
    try {
      root = MAPPER.readTree(json);
    } catch (JsonProcessingException e) {
      throw new ProtocolException(
          Reason.MALFORMED_JSON, "not JSON: " + e.getOriginalMessage(), null);
    }
    if (root == null || !root.isObject()) {
      throw new ProtocolException(Reason.MALFORMED_JSON, "event must be a JSON object", "");
    }
    String protocolVersion = requiredString(root, "protocolVersion", "");
    ProtocolVersion.Parsed parsed;
    try {
      parsed = ProtocolVersion.parse(protocolVersion);
    } catch (IllegalArgumentException e) {
      throw invalid("/protocolVersion", "must be a semantic version");
    }
    if (!ProtocolVersion.isSupported(parsed)) {
      throw new ProtocolException(
          Reason.UNSUPPORTED_PROTOCOL_VERSION,
          "protocol version " + protocolVersion + " is outside the supported line 0.2",
          "/protocolVersion");
    }
    String eventType = requiredString(root, "eventType", "");
    if (!EVENT_TYPE.matcher(eventType).matches()) {
      throw invalid("/eventType", "must be dotted lower-case words");
    }
    String eventId = identifier(root, "eventId");
    String runId = identifier(root, "runId");
    String sessionId = identifier(root, "sessionId");
    long sequence = integral(root, "sequence", "");
    if (sequence < 1) {
      throw invalid("/sequence", "must be >= 1");
    }
    String occurredAt = requiredString(root, "occurredAt", "");
    if (!TIMESTAMP.matcher(occurredAt).matches()) {
      throw invalid("/occurredAt", "must be an ISO-8601 timestamp with offset");
    }
    Boolean ignorable = null;
    JsonNode ig = root.get("ignorable");
    if (ig != null && !ig.isNull()) {
      if (!ig.isBoolean()) {
        throw invalid("/ignorable", "must be a boolean");
      }
      ignorable = ig.booleanValue();
    }
    JsonNode payload = root.get("payload");
    if (payload == null || !payload.isObject()) {
      throw invalid("/payload", "must be an object");
    }
    Payload typed = readPayload(eventType, (ObjectNode) payload, Boolean.TRUE.equals(ignorable));
    return new Event(
        protocolVersion,
        eventId,
        eventType,
        runId,
        sessionId,
        sequence,
        occurredAt,
        ignorable,
        typed);
  }

  private static Payload readPayload(String eventType, ObjectNode p, boolean ignorable) {
    final String at = "/payload";
    return switch (eventType) {
      case EventTypes.SESSION_STARTED ->
          new SessionStarted(
              component(required(p, "producer", at), at + "/producer"),
              optionalObject(p, "runner", at, n -> component(n, at + "/runner")),
              stringMap(p, "environment", at),
              optionalObject(p, "executor", at, n -> executor(n, at + "/executor")),
              optionalObject(p, "source", at, n -> source(n, at + "/source")),
              stringMap(p, "labels", at));
      case EventTypes.SESSION_FINISHED -> new SessionFinished();
      case EventTypes.RUN_FINISHED -> new RunFinished();
      case EventTypes.ATTEMPT_STARTED -> {
        long n = integral(p, "attemptNumber", at);
        if (n < 1 || n > 1000) {
          throw invalid(at + "/attemptNumber", "must be between 1 and 1000");
        }
        yield new AttemptStarted(
            identifier(p, "attemptId", at),
            (int) n,
            testCase(required(p, "test", at), at + "/test"));
      }
      case EventTypes.ATTEMPT_FINISHED ->
          new AttemptFinished(
              identifier(p, "attemptId", at),
              status(p, at),
              optionalString(p, "rawStatus", at),
              expectedStatus(p, at),
              optionalIntegral(p, "durationMs", at),
              failures(p, at));
      case EventTypes.STEP_STARTED ->
          new StepStarted(
              identifier(p, "stepId", at),
              identifier(p, "attemptId", at),
              optionalIdentifier(p, "parentStepId", at),
              requiredString(p, "name", at),
              optionalString(p, "kind", at),
              optionalObject(p, "location", at, n -> location(n, at + "/location")));
      case EventTypes.STEP_FINISHED ->
          new StepFinished(
              identifier(p, "stepId", at),
              identifier(p, "attemptId", at),
              status(p, at),
              optionalString(p, "rawStatus", at),
              optionalIntegral(p, "durationMs", at),
              failures(p, at));
      case EventTypes.ATTACHMENT_ADDED ->
          new AttachmentAdded(
              identifier(p, "attemptId", at),
              optionalIdentifier(p, "stepId", at),
              requiredString(p, "name", at),
              requiredString(p, "mediaType", at),
              integral(p, "sizeBytes", at),
              requiredString(p, "sha256", at));
      case EventTypes.SCOPE_FAILED -> {
        List<PathSegment> path = pathSegments(required(p, "path", at), at + "/path");
        if (path.isEmpty()) {
          throw invalid(at + "/path", "must identify the failing scope");
        }
        List<Failure> failures = failures(p, at);
        if (failures.isEmpty()) {
          throw invalid(at + "/failures", "a scope failure carries at least one failure");
        }
        yield new ScopeFailed(
            path,
            optionalString(p, "displayName", at),
            optionalString(p, "rawStatus", at),
            optionalObject(p, "location", at, n -> location(n, at + "/location")),
            failures);
      }
      default -> {
        if (!ignorable) {
          throw new ProtocolException(
              Reason.UNSUPPORTED_EVENT_TYPE,
              "event type " + eventType + " is not known and not marked ignorable",
              "/eventType");
        }
        yield new UnknownPayload(eventType, p.toString());
      }
    };
  }

  private static TestCase testCase(JsonNode n, String at) {
    if (!n.isObject()) {
      throw invalid(at, "must be an object");
    }
    String stabilityRaw = requiredString(n, "historicalIdStability", at);
    HistoricalIdStability stability = HistoricalIdStability.fromWireName(stabilityRaw);
    if (stability == null) {
      throw invalid(at + "/historicalIdStability", "unknown value " + shown(stabilityRaw));
    }
    String historicalId = optionalString(n, "historicalId", at);
    if (stability == HistoricalIdStability.UNAVAILABLE && historicalId != null) {
      throw invalid(
          at + "/historicalId", "must be absent when historicalIdStability is unavailable");
    }
    if (stability != HistoricalIdStability.UNAVAILABLE && historicalId == null) {
      throw invalid(at, "historicalId is required unless historicalIdStability is unavailable");
    }
    List<PathSegment> path = pathSegments(required(n, "path", at), at + "/path");
    return new TestCase(
        identifier(n, "executionId", at),
        historicalId,
        stability,
        requiredString(n, "displayName", at),
        path,
        optionalObject(n, "location", at, l -> location(l, at + "/location")),
        stringList(n, "tags", at),
        stringMap(n, "labels", at));
  }

  private static List<PathSegment> pathSegments(JsonNode pathNode, String at) {
    if (!pathNode.isArray()) {
      throw invalid(at, "must be an array");
    }
    List<PathSegment> path = new ArrayList<>();
    int i = 0;
    for (JsonNode seg : pathNode) {
      String segAt = at + "/" + i++;
      if (!seg.isObject()) {
        throw invalid(segAt, "must be an object");
      }
      path.add(
          new PathSegment(requiredString(seg, "kind", segAt), requiredString(seg, "name", segAt)));
    }
    return path;
  }

  private static List<Failure> failures(JsonNode p, String at) {
    JsonNode arr = p.get("failures");
    if (arr == null || arr.isNull()) {
      return List.of();
    }
    if (!arr.isArray()) {
      throw invalid(at + "/failures", "must be an array");
    }
    List<Failure> out = new ArrayList<>();
    int i = 0;
    for (JsonNode f : arr) {
      String fAt = at + "/failures/" + i++;
      if (!f.isObject()) {
        throw invalid(fAt, "must be an object");
      }
      FailurePhase phase = null;
      String phaseRaw = optionalString(f, "phase", fAt);
      if (phaseRaw != null) {
        phase = FailurePhase.fromWireName(phaseRaw);
        if (phase == null) {
          throw invalid(fAt + "/phase", "unknown value " + shown(phaseRaw));
        }
      }
      out.add(
          new Failure(
              requiredString(f, "message", fAt),
              optionalString(f, "type", fAt),
              optionalString(f, "stackTrace", fAt),
              phase,
              optionalObject(f, "location", fAt, l -> location(l, fAt + "/location"))));
    }
    return out;
  }

  private static Status status(JsonNode p, String at) {
    String raw = requiredString(p, "status", at);
    Status s = Status.fromWireName(raw);
    if (s == null) {
      throw invalid(at + "/status", "unknown value " + shown(raw));
    }
    return s;
  }

  private static @Nullable ExpectedStatus expectedStatus(JsonNode p, String at) {
    String raw = optionalString(p, "expectedStatus", at);
    if (raw == null) {
      return null;
    }
    ExpectedStatus s = ExpectedStatus.fromWireName(raw);
    if (s == null) {
      throw invalid(at + "/expectedStatus", "unknown value " + shown(raw));
    }
    return s;
  }

  private static Component component(JsonNode n, String at) {
    if (!n.isObject()) {
      throw invalid(at, "must be an object");
    }
    return new Component(requiredString(n, "name", at), optionalString(n, "version", at));
  }

  private static Executor executor(JsonNode n, String at) {
    if (!n.isObject()) {
      throw invalid(at, "must be an object");
    }
    return new Executor(
        optionalString(n, "name", at),
        optionalString(n, "buildId", at),
        optionalString(n, "buildUrl", at));
  }

  private static Source source(JsonNode n, String at) {
    if (!n.isObject()) {
      throw invalid(at, "must be an object");
    }
    return new Source(
        optionalString(n, "repository", at),
        optionalString(n, "revision", at),
        optionalString(n, "branch", at));
  }

  private static Location location(JsonNode n, String at) {
    if (!n.isObject()) {
      throw invalid(at, "must be an object");
    }
    return new Location(
        requiredString(n, "file", at),
        optionalIntegral(n, "line", at),
        optionalIntegral(n, "column", at));
  }

  private static Map<String, String> stringMap(JsonNode p, String field, String at) {
    JsonNode n = p.get(field);
    if (n == null || n.isNull()) {
      return Map.of();
    }
    if (!n.isObject()) {
      throw invalid(at + "/" + field, "must be an object of strings");
    }
    Map<String, String> out = new LinkedHashMap<>();
    for (Map.Entry<String, JsonNode> e : n.properties()) {
      if (!e.getValue().isTextual()) {
        throw invalid(at + "/" + field + "/" + e.getKey(), "must be a string");
      }
      out.put(e.getKey(), e.getValue().textValue());
    }
    return out;
  }

  private static List<String> stringList(JsonNode p, String field, String at) {
    JsonNode n = p.get(field);
    if (n == null || n.isNull()) {
      return List.of();
    }
    if (!n.isArray()) {
      throw invalid(at + "/" + field, "must be an array of strings");
    }
    List<String> out = new ArrayList<>();
    int i = 0;
    for (JsonNode item : n) {
      if (!item.isTextual()) {
        throw invalid(at + "/" + field + "/" + i, "must be a string");
      }
      out.add(item.textValue());
      i++;
    }
    return out;
  }

  private static <T> @Nullable T optionalObject(
      JsonNode p, String field, String at, Function<JsonNode, T> reader) {
    JsonNode n = p.get(field);
    if (n == null || n.isNull()) {
      return null;
    }
    if (!n.isObject()) {
      throw invalid(at + "/" + field, "must be an object");
    }
    return reader.apply(n);
  }

  private static JsonNode required(JsonNode p, String field, String at) {
    JsonNode n = p.get(field);
    if (n == null || n.isNull()) {
      throw invalid(at, "missing required property " + field);
    }
    return n;
  }

  private static String requiredString(JsonNode p, String field, String at) {
    JsonNode n = required(p, field, at);
    if (!n.isTextual()) {
      throw invalid(at + "/" + field, "must be a string");
    }
    return n.textValue();
  }

  private static @Nullable String optionalString(JsonNode p, String field, String at) {
    JsonNode n = p.get(field);
    if (n == null || n.isNull()) {
      return null;
    }
    if (!n.isTextual()) {
      throw invalid(at + "/" + field, "must be a string");
    }
    return n.textValue();
  }

  private static String identifier(JsonNode p, String field) {
    return identifier(p, field, "");
  }

  private static String identifier(JsonNode p, String field, String at) {
    String s = requiredString(p, field, at);
    if (!IDENTIFIER.matcher(s).matches()) {
      throw invalid(at + "/" + field, "must be printable ASCII without spaces");
    }
    return s;
  }

  private static @Nullable String optionalIdentifier(JsonNode p, String field, String at) {
    String s = optionalString(p, field, at);
    if (s != null && !IDENTIFIER.matcher(s).matches()) {
      throw invalid(at + "/" + field, "must be printable ASCII without spaces");
    }
    return s;
  }

  private static long integral(JsonNode p, String field, String at) {
    JsonNode n = required(p, field, at);
    if (!n.isIntegralNumber() || !n.canConvertToLong()) {
      throw invalid(at + "/" + field, "must be an integer");
    }
    return n.longValue();
  }

  private static @Nullable Long optionalIntegral(JsonNode p, String field, String at) {
    JsonNode n = p.get(field);
    if (n == null || n.isNull()) {
      return null;
    }
    if (!n.isIntegralNumber() || !n.canConvertToLong()) {
      throw invalid(at + "/" + field, "must be an integer");
    }
    return n.longValue();
  }

  /** A producer-supplied value quoted for a diagnostic: bounded and without control characters. */
  private static String shown(String value) {
    StringBuilder sb = new StringBuilder("\"");
    int limit = Math.min(value.length(), 64);
    for (int i = 0; i < limit; i++) {
      char c = value.charAt(i);
      if (c < 0x20 || c == 0x7F) {
        sb.append(String.format("\\u%04x", (int) c));
      } else if (c == '"' || c == '\\') {
        sb.append('\\').append(c);
      } else {
        sb.append(c);
      }
    }
    return sb.append(value.length() > limit ? "\"..." : "\"").toString();
  }

  private static ProtocolException invalid(String pointer, String message) {
    return new ProtocolException(Reason.SCHEMA_INVALID, pointer + ": " + message, pointer);
  }

  // ---------------------------------------------------------------- write

  public static String write(Event e) {
    ObjectNode root = F.objectNode();
    root.put("protocolVersion", e.protocolVersion());
    root.put("eventId", e.eventId());
    root.put("eventType", e.eventType());
    root.put("runId", e.runId());
    root.put("sessionId", e.sessionId());
    root.put("sequence", e.sequence());
    root.put("occurredAt", e.occurredAt());
    if (e.ignorable() != null) {
      root.put("ignorable", e.ignorable());
    }
    root.set("payload", writePayload(e.payload()));
    try {
      return MAPPER.writeValueAsString(root);
    } catch (JsonProcessingException ex) {
      throw new IllegalStateException("cannot serialise event", ex);
    }
  }

  private static ObjectNode writePayload(Payload payload) {
    ObjectNode p = F.objectNode();
    if (payload instanceof SessionStarted s) {
      p.set("producer", component(s.producer()));
      if (s.runner() != null) {
        p.set("runner", component(s.runner()));
      }
      if (!s.environment().isEmpty()) {
        p.set("environment", stringMap(s.environment()));
      }
      if (s.executor() != null) {
        ObjectNode x = F.objectNode();
        putIfPresent(x, "name", s.executor().name());
        putIfPresent(x, "buildId", s.executor().buildId());
        putIfPresent(x, "buildUrl", s.executor().buildUrl());
        p.set("executor", x);
      }
      if (s.source() != null) {
        ObjectNode x = F.objectNode();
        putIfPresent(x, "repository", s.source().repository());
        putIfPresent(x, "revision", s.source().revision());
        putIfPresent(x, "branch", s.source().branch());
        p.set("source", x);
      }
      if (!s.labels().isEmpty()) {
        p.set("labels", stringMap(s.labels()));
      }
    } else if (payload instanceof AttemptStarted a) {
      p.put("attemptId", a.attemptId());
      p.put("attemptNumber", a.attemptNumber());
      p.set("test", testCase(a.test()));
    } else if (payload instanceof AttemptFinished a) {
      p.put("attemptId", a.attemptId());
      p.put("status", a.status().wireName());
      putIfPresent(p, "rawStatus", a.rawStatus());
      if (a.expectedStatus() != null) {
        p.put("expectedStatus", a.expectedStatus().wireName());
      }
      if (a.durationMs() != null) {
        p.put("durationMs", a.durationMs());
      }
      if (!a.failures().isEmpty()) {
        p.set("failures", failures(a.failures()));
      }
    } else if (payload instanceof StepStarted s) {
      p.put("stepId", s.stepId());
      p.put("attemptId", s.attemptId());
      putIfPresent(p, "parentStepId", s.parentStepId());
      p.put("name", s.name());
      putIfPresent(p, "kind", s.kind());
      if (s.location() != null) {
        p.set("location", location(s.location()));
      }
    } else if (payload instanceof StepFinished s) {
      p.put("stepId", s.stepId());
      p.put("attemptId", s.attemptId());
      p.put("status", s.status().wireName());
      putIfPresent(p, "rawStatus", s.rawStatus());
      if (s.durationMs() != null) {
        p.put("durationMs", s.durationMs());
      }
      if (!s.failures().isEmpty()) {
        p.set("failures", failures(s.failures()));
      }
    } else if (payload instanceof AttachmentAdded a) {
      p.put("attemptId", a.attemptId());
      putIfPresent(p, "stepId", a.stepId());
      p.put("name", a.name());
      p.put("mediaType", a.mediaType());
      p.put("sizeBytes", a.sizeBytes());
      p.put("sha256", a.sha256());
    } else if (payload instanceof ScopeFailed s) {
      p.set("path", pathSegments(s.path()));
      putIfPresent(p, "displayName", s.displayName());
      putIfPresent(p, "rawStatus", s.rawStatus());
      if (s.location() != null) {
        p.set("location", location(s.location()));
      }
      p.set("failures", failures(s.failures()));
    } else if (payload instanceof UnknownPayload u) {
      try {
        JsonNode raw = MAPPER.readTree(u.payloadJson());
        if (raw instanceof ObjectNode o) {
          return o;
        }
        throw new IllegalStateException("unknown payload is not an object");
      } catch (JsonProcessingException ex) {
        throw new IllegalStateException("unknown payload is not JSON", ex);
      }
    }
    // SessionFinished and RunFinished have empty payloads.
    return p;
  }

  private static ObjectNode testCase(TestCase t) {
    ObjectNode n = F.objectNode();
    n.put("executionId", t.executionId());
    putIfPresent(n, "historicalId", t.historicalId());
    n.put("historicalIdStability", t.historicalIdStability().wireName());
    n.put("displayName", t.displayName());
    n.set("path", pathSegments(t.path()));
    if (t.location() != null) {
      n.set("location", location(t.location()));
    }
    if (!t.tags().isEmpty()) {
      ArrayNode tags = F.arrayNode();
      t.tags().forEach(tags::add);
      n.set("tags", tags);
    }
    if (!t.labels().isEmpty()) {
      n.set("labels", stringMap(t.labels()));
    }
    return n;
  }

  private static ArrayNode pathSegments(List<PathSegment> segments) {
    ArrayNode path = F.arrayNode();
    for (PathSegment seg : segments) {
      ObjectNode s = F.objectNode();
      s.put("kind", seg.kind());
      s.put("name", seg.name());
      path.add(s);
    }
    return path;
  }

  private static ArrayNode failures(List<Failure> failures) {
    ArrayNode arr = F.arrayNode();
    for (Failure f : failures) {
      ObjectNode n = F.objectNode();
      n.put("message", f.message());
      putIfPresent(n, "type", f.type());
      putIfPresent(n, "stackTrace", f.stackTrace());
      if (f.phase() != null) {
        n.put("phase", f.phase().wireName());
      }
      if (f.location() != null) {
        n.set("location", location(f.location()));
      }
      arr.add(n);
    }
    return arr;
  }

  private static ObjectNode location(Location l) {
    ObjectNode n = F.objectNode();
    n.put("file", l.file());
    if (l.line() != null) {
      n.put("line", l.line());
    }
    if (l.column() != null) {
      n.put("column", l.column());
    }
    return n;
  }

  private static ObjectNode component(Component c) {
    ObjectNode n = F.objectNode();
    n.put("name", c.name());
    putIfPresent(n, "version", c.version());
    return n;
  }

  private static ObjectNode stringMap(Map<String, String> map) {
    ObjectNode n = F.objectNode();
    map.forEach(n::put);
    return n;
  }

  private static void putIfPresent(ObjectNode n, String field, @Nullable String value) {
    if (value != null) {
      n.put(field, value);
    }
  }
}
