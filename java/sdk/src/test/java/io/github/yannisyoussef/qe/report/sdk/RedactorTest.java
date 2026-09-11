package io.github.yannisyoussef.qe.report.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.DynamicTest.dynamicTest;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.yannisyoussef.qe.report.protocol.AttemptFinished;
import io.github.yannisyoussef.qe.report.protocol.Event;
import io.github.yannisyoussef.qe.report.protocol.ProtocolJson;
import io.github.yannisyoussef.qe.report.protocol.testing.Corpus;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

class RedactorTest {
  private static final Redactor R = Redactor.defaults();

  @TestFactory
  List<DynamicTest> corpus() {
    JsonNode cases = Corpus.readJson(Corpus.fixtures().resolve("redaction/cases.json"));
    List<DynamicTest> tests = new ArrayList<>();
    for (JsonNode c : cases.get("text")) {
      tests.add(
          dynamicTest(
              c.get("name").asText(),
              () ->
                  assertEquals(c.get("expected").asText(), R.redactText(c.get("input").asText()))));
    }
    for (JsonNode c : cases.get("headers")) {
      tests.add(
          dynamicTest(
              c.get("name").asText(),
              () ->
                  assertEquals(toMap(c.get("expected")), R.redactHeaders(toMap(c.get("input"))))));
    }
    return tests;
  }

  private static Map<String, String> toMap(JsonNode n) {
    Map<String, String> m = new LinkedHashMap<>();
    n.properties().forEach(e -> m.put(e.getKey(), e.getValue().asText()));
    return m;
  }

  @Test
  void customKeysHeadersAndRules() {
    Redactor custom =
        Redactor.builder()
            .sensitiveKey("otp")
            .sensitiveHeader("X-Magic")
            .rule(Pattern.compile("ACME-[0-9]+"), "<acme>")
            .build();
    assertEquals(
        "otp=[REDACTED]; x-magic: [REDACTED]", custom.redactText("otp=123456; x-magic: abc"));
    assertEquals("id <acme> password=[REDACTED]", custom.redactText("id ACME-42 password=x"));
    assertEquals("otp=123456", R.redactText("otp=123456"), "instances do not share state");
  }

  @Test
  void eventRedactionLeavesStructureAndEnvelopeAlone() {
    String line =
        "{\"protocolVersion\":\"0.1.0\",\"eventId\":\"e-1\",\"eventType\":\"attempt.finished\","
            + "\"runId\":\"r\",\"sessionId\":\"s\",\"sequence\":1,\"occurredAt\":\"2026-01-01T00:00:00.000Z\","
            + "\"payload\":{\"attemptId\":\"password=keep-me\",\"status\":\"failed\",\"rawStatus\":\"token=raw\","
            + "\"failures\":[{\"message\":\"Authorization: Bearer abc\",\"type\":\"x\","
            + "\"stackTrace\":\"password=hunter2\\n\\tat a.b(C.java:1)\"}]}}";
    Event e = R.redactEvent(ProtocolJson.read(line));
    AttemptFinished p = assertInstanceOf(AttemptFinished.class, e.payload());
    assertEquals("e-1", e.eventId());
    assertEquals("password=keep-me", p.attemptId());
    assertEquals("token=raw", p.rawStatus());
    assertEquals("Authorization: [REDACTED]", p.failures().get(0).message());
    assertEquals("password=[REDACTED]\n\tat a.b(C.java:1)", p.failures().get(0).stackTrace());
  }
}
