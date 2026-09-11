package io.github.yannisyoussef.qe.report.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.DynamicTest.dynamicTest;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.yannisyoussef.qe.report.protocol.testing.Corpus;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

/** The fixture corpus is the executable specification; every entry of the manifest is a test. */
class CorpusTest {
  private static final com.fasterxml.jackson.databind.json.JsonMapper TYPE_MAPPER =
      com.fasterxml.jackson.databind.json.JsonMapper.builder().build();
  private static final Set<String> CODEC_REASONS =
      Set.of(
          "MALFORMED_JSON",
          "SCHEMA_INVALID",
          "UNSUPPORTED_PROTOCOL_VERSION",
          "UNSUPPORTED_EVENT_TYPE");

  @TestFactory
  List<DynamicTest> validEvents() {
    List<DynamicTest> tests = new ArrayList<>();
    for (JsonNode entry : Corpus.manifest().get("events").get("valid")) {
      String file = entry.get("file").asText();
      boolean exact = "exact".equals(entry.get("roundTrip").asText());
      tests.add(
          dynamicTest(
              file,
              () -> {
                String text = Corpus.readText(Corpus.fixtures().resolve(file));
                Event event = ProtocolJson.read(text);
                if (event.payload() instanceof UnknownPayload) {
                  assertTrue(event.isIgnorable(), "unknown type must be ignorable");
                } else {
                  assertTrue(
                      SchemaValidation.isValid(text),
                      () -> SchemaValidation.describe(SchemaValidation.errors(text)));
                }
                String written = ProtocolJson.write(event);
                if (!(event.payload() instanceof UnknownPayload)) {
                  assertTrue(
                      SchemaValidation.isValid(written),
                      () -> SchemaValidation.describe(SchemaValidation.errors(written)));
                }
                if (exact) {
                  assertEquals(Corpus.canonical(text), Corpus.canonical(written));
                }
                String again = ProtocolJson.write(ProtocolJson.read(written));
                assertEquals(Corpus.canonical(written), Corpus.canonical(again), "idempotent");
              }));
    }
    return tests;
  }

  @TestFactory
  List<DynamicTest> invalidEvents() {
    List<DynamicTest> tests = new ArrayList<>();
    for (JsonNode entry : Corpus.manifest().get("events").get("invalid")) {
      String file = entry.get("file").asText();
      String reason = entry.get("reason").asText();
      JsonNode pointerNode = entry.get("pointer");
      String pointer = pointerNode.isNull() ? null : pointerNode.asText();
      boolean reject = "reject".equals(entry.get("codec").asText());
      tests.add(
          dynamicTest(
              file + " -> " + reason,
              () -> {
                String text = Corpus.readText(Corpus.fixtures().resolve(file));
                if (reason.equals("SCHEMA_INVALID")) {
                  assertFalse(SchemaValidation.errors(text).isEmpty(), "schema must reject");
                  String type = TYPE_MAPPER.readTree(text).path("eventType").asText();
                  var typed =
                      EventTypes.isKnown(type)
                          ? SchemaValidation.errorsForType(text, type)
                          : SchemaValidation.errors(text);
                  assertFalse(typed.isEmpty(), "typed schema must reject");
                  if (pointer != null) {
                    assertTrue(
                        typed.stream().map(SchemaValidation::pointer).anyMatch(pointer::equals),
                        () ->
                            "expected exact pointer "
                                + pointer
                                + " in "
                                + SchemaValidation.describe(typed));
                  }
                }
                if (reject) {
                  ProtocolException ex =
                      assertThrows(ProtocolException.class, () -> ProtocolJson.read(text));
                  assertEquals(reason, ex.reason().name());
                  if (pointer != null && ex.pointer() != null) {
                    assertTrue(
                        ex.pointer().startsWith(pointer),
                        () -> "codec pointer " + ex.pointer() + " must refine " + pointer);
                  }
                } else {
                  ProtocolJson.read(text);
                }
              }));
    }
    return tests;
  }

  @TestFactory
  List<DynamicTest> runs() {
    List<DynamicTest> tests = new ArrayList<>();
    for (JsonNode run : Corpus.manifest().get("runs")) {
      String dir = run.get("dir").asText();
      boolean invalid = "INVALID".equals(run.get("outcome").asText());
      String reason = run.hasNonNull("reason") ? run.get("reason").asText() : null;
      int badLine = run.hasNonNull("line") ? run.get("line").asInt() : -1;
      boolean idempotentOnly = run.hasNonNull("roundTrip");
      tests.add(
          dynamicTest(
              dir,
              () -> {
                Path runDir = Corpus.fixtures().resolve(dir);
                List<String> lines = Corpus.runLines(runDir);
                for (int i = 0; i < lines.size(); i++) {
                  String line = lines.get(i);
                  int number = i + 1;
                  if (invalid
                      && reason != null
                      && CODEC_REASONS.contains(reason)
                      && number == badLine) {
                    ProtocolException ex =
                        assertThrows(ProtocolException.class, () -> ProtocolJson.read(line));
                    assertEquals(reason, ex.reason().name());
                    continue;
                  }
                  Event event = ProtocolJson.read(line);
                  if (!(event.payload() instanceof UnknownPayload)) {
                    assertTrue(
                        SchemaValidation.isValid(line),
                        () ->
                            dir
                                + ":"
                                + number
                                + " "
                                + SchemaValidation.describe(SchemaValidation.errors(line)));
                  }
                  String written = ProtocolJson.write(event);
                  if (!idempotentOnly) {
                    assertEquals(
                        Corpus.canonical(line), Corpus.canonical(written), dir + ":" + number);
                  }
                }
              }));
    }
    return tests;
  }

  @TestFactory
  List<DynamicTest> limitsBeyondTheCommittedCorpus() {
    String base =
        Corpus.readText(
            Corpus.fixtures().resolve("events/valid/attempt-finished-failed-full.json"));
    Event event = ProtocolJson.read(base);
    AttemptFinished payload = assertInstanceOf(AttemptFinished.class, event.payload());
    return List.of(
        dynamicTest(
            "message at 65536 accepted, 65537 rejected",
            () -> {
              assertTrue(SchemaValidation.isValid(withMessage(event, payload, "m".repeat(65536))));
              assertFalse(SchemaValidation.isValid(withMessage(event, payload, "m".repeat(65537))));
            }),
        dynamicTest(
            "stack trace at 262144 accepted, 262145 rejected",
            () -> {
              assertTrue(SchemaValidation.isValid(withStack(event, payload, "s".repeat(262144))));
              assertFalse(SchemaValidation.isValid(withStack(event, payload, "s".repeat(262145))));
            }));
  }

  private static String withMessage(Event e, AttemptFinished p, String message) {
    return ProtocolJson.write(replacePayload(e, p, List.of(Failure.of(message))));
  }

  private static String withStack(Event e, AttemptFinished p, String stack) {
    return ProtocolJson.write(
        replacePayload(e, p, List.of(new Failure("x", null, stack, null, null))));
  }

  private static Event replacePayload(Event e, AttemptFinished p, List<Failure> failures) {
    AttemptFinished np =
        new AttemptFinished(
            p.attemptId(), p.status(), p.rawStatus(), p.expectedStatus(), p.durationMs(), failures);
    return new Event(
        e.protocolVersion(),
        e.eventId(),
        e.eventType(),
        e.runId(),
        e.sessionId(),
        e.sequence(),
        e.occurredAt(),
        e.ignorable(),
        np);
  }
}
