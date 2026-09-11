package io.github.yannisyoussef.qe.report.sdk;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.yannisyoussef.qe.report.protocol.AttachmentAdded;
import io.github.yannisyoussef.qe.report.protocol.AttemptFinished;
import io.github.yannisyoussef.qe.report.protocol.AttemptStarted;
import io.github.yannisyoussef.qe.report.protocol.Component;
import io.github.yannisyoussef.qe.report.protocol.Event;
import io.github.yannisyoussef.qe.report.protocol.Failure;
import io.github.yannisyoussef.qe.report.protocol.HistoricalIdStability;
import io.github.yannisyoussef.qe.report.protocol.PathSegment;
import io.github.yannisyoussef.qe.report.protocol.ProtocolJson;
import io.github.yannisyoussef.qe.report.protocol.SessionStarted;
import io.github.yannisyoussef.qe.report.protocol.Status;
import io.github.yannisyoussef.qe.report.protocol.TestCase;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ReportSessionTest {
  /** A clock that advances one second per reading. */
  static final class TickingClock extends Clock {
    private Instant now = Instant.parse("2026-01-01T00:00:00Z");

    @Override
    public ZoneId getZone() {
      return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(ZoneId zone) {
      return this;
    }

    @Override
    public Instant instant() {
      Instant current = now;
      now = now.plusSeconds(1);
      return current;
    }
  }

  static Supplier<String> counter() {
    AtomicInteger n = new AtomicInteger();
    return () -> String.format("evt-%04d", n.incrementAndGet());
  }

  static final TestCase TEST =
      new TestCase(
          "t-1",
          "suite::t-1",
          HistoricalIdStability.STABLE,
          "a test",
          List.of(new PathSegment("file", "a.spec")),
          null,
          List.of(),
          Map.of());

  private static String run(Path dir, List<ReportProblem> problems) throws IOException {
    try (ReportSession s =
        ReportSession.builder("run-1", "sess-1", FileSink.open(dir))
            .clock(new TickingClock())
            .ids(counter())
            .problems(problems::add)
            .start(
                new SessionStarted(
                    new Component("test", "0"), null, Map.of(), null, null, Map.of()))) {
      s.emit(new AttemptStarted("a-1", 1, TEST));
      s.attach(
          "a-1", null, "log", "text/plain", "password=hunter2".getBytes(StandardCharsets.UTF_8));
      s.emit(
          new AttemptFinished(
              "a-1", Status.FAILED, null, null, null, List.of(Failure.of("token=abc"))));
      s.finishRun();
      assertEquals(new ReportSession.Summary(6, 0), s.summary());
    }
    return Files.readString(dir.resolve("events.ndjson"));
  }

  @Test
  void deterministicForFixedClockAndIds(@TempDir Path a, @TempDir Path b) throws IOException {
    List<ReportProblem> problems = new ArrayList<>();
    String first = run(a, problems);
    assertEquals(first, run(b, problems));
    assertEquals(List.of(), problems);
    List<Event> events = first.lines().map(ProtocolJson::read).toList();
    assertEquals(
        List.of(
            "session.started",
            "attempt.started",
            "attachment.added",
            "attempt.finished",
            "session.finished",
            "run.finished"),
        events.stream().map(Event::eventType).toList());
    assertEquals(List.of(1L, 2L, 3L, 4L, 5L, 6L), events.stream().map(Event::sequence).toList());
    assertEquals("2026-01-01T00:00:00.000Z", events.get(0).occurredAt());
    assertEquals("2026-01-01T00:00:01.000Z", events.get(1).occurredAt());
    AttachmentAdded att = assertInstanceOf(AttachmentAdded.class, events.get(2).payload());
    byte[] redacted = "password=[REDACTED]".getBytes(StandardCharsets.UTF_8);
    assertEquals(HexFormat.of().formatHex(FileSink.sha256().digest(redacted)), att.sha256());
    assertEquals(redacted.length, att.sizeBytes());
    AttemptFinished fin = assertInstanceOf(AttemptFinished.class, events.get(3).payload());
    assertEquals("token=[REDACTED]", fin.failures().get(0).message());
  }

  @Test
  void binaryAttachmentsAreStoredUntouched(@TempDir Path dir) throws IOException {
    byte[] png = "password=notreallyapng".getBytes(StandardCharsets.UTF_8);
    try (ReportSession s =
        ReportSession.builder("r", "s", FileSink.open(dir))
            .clock(new TickingClock())
            .ids(counter())
            .start(SessionStarted.of(new Component("test", null)))) {
      s.emit(new AttemptStarted("a-1", 1, TEST));
      assertTrue(s.attach("a-1", null, "../../etc/passwd", "image/png", png));
    }
    String hash = HexFormat.of().formatHex(FileSink.sha256().digest(png));
    assertArrayEquals(png, Files.readAllBytes(dir.resolve("attachments").resolve(hash)));
  }

  @Test
  void oversizedEventIsDroppedAndReported(@TempDir Path dir) throws IOException {
    List<ReportProblem> problems = new ArrayList<>();
    try (ReportSession s =
        ReportSession.builder("r", "s", FileSink.open(dir))
            .clock(new TickingClock())
            .ids(counter())
            .problems(problems::add)
            .maxEventBytes(400)
            .start(SessionStarted.of(new Component("test", null)))) {
      assertFalse(
          s.emit(
              new AttemptFinished(
                  "a", Status.FAILED, null, null, null, List.of(Failure.of("x".repeat(500))))));
      assertEquals(
          List.of(ReportProblem.Kind.EVENT_TOO_LARGE),
          problems.stream().map(ReportProblem::kind).toList());
      assertTrue(s.emit(AttemptFinished.of("a", Status.PASSED)));
      s.finish();
      assertEquals(new ReportSession.Summary(3, 1), s.summary());
    }
  }

  @Test
  void sinkFailuresNeverEscape() {
    ReportSink broken =
        new ReportSink() {
          @Override
          public void write(Event event) throws IOException {
            throw new IOException("disk full");
          }

          @Override
          public StoredAttachment storeAttachment(InputStream bytes) throws IOException {
            throw new IOException("disk full");
          }

          @Override
          public void close() throws IOException {
            throw new IOException("disk full");
          }
        };
    List<ReportProblem> problems = new ArrayList<>();
    ReportSession s =
        ReportSession.builder("r", "s", broken)
            .clock(new TickingClock())
            .ids(counter())
            .problems(problems::add)
            .start(SessionStarted.of(new Component("test", null)));
    assertFalse(s.attach("a", null, "x", "text/plain", "y".getBytes(StandardCharsets.UTF_8)));
    s.close();
    assertEquals(4, problems.size());
    assertTrue(problems.stream().allMatch(p -> p.kind() == ReportProblem.Kind.SINK_FAILURE));
  }

  @Test
  void eventsAfterFinishAreDroppedAndReported(@TempDir Path dir) throws IOException {
    List<ReportProblem> problems = new ArrayList<>();
    try (ReportSession s =
        ReportSession.builder("r", "s", FileSink.open(dir))
            .clock(new TickingClock())
            .ids(counter())
            .problems(problems::add)
            .start(SessionStarted.of(new Component("test", null)))) {
      s.finish();
      assertFalse(s.emit(AttemptFinished.of("a", Status.PASSED)));
    }
    assertEquals(
        List.of(ReportProblem.Kind.SESSION_FINISHED),
        problems.stream().map(ReportProblem::kind).toList());
  }

  @Test
  void eventLimitCannotBeRaised(@TempDir Path dir) throws IOException {
    try (FileSink sink = FileSink.open(dir)) {
      assertThrows(
          IllegalArgumentException.class,
          () -> ReportSession.builder("r", "s", sink).maxEventBytes(2_000_000));
    }
  }

  @Test
  void environmentCaptureIsAllowlistOnlyAndRedacted() {
    Map<String, String> env =
        Map.of(
            "CI",
            "true",
            "SECRET_TOKEN",
            "abc",
            "PATH",
            "/usr/bin",
            "DB_URL",
            "postgres://user:pw@host/db");
    assertEquals(
        Map.of("CI", "true", "DB_URL", "postgres://[REDACTED]@host/db"),
        EnvironmentCapture.fromMap(env, List.of("CI", "DB_URL", "MISSING"), Redactor.defaults()));
    assertEquals(
        Map.of("SECRET_TOKEN", "abc"),
        EnvironmentCapture.fromMap(env, List.of("SECRET_TOKEN"), Redactor.defaults()));
  }
}
