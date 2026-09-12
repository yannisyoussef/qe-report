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
import io.github.yannisyoussef.qe.report.protocol.FailurePhase;
import io.github.yannisyoussef.qe.report.protocol.HistoricalIdStability;
import io.github.yannisyoussef.qe.report.protocol.PathSegment;
import io.github.yannisyoussef.qe.report.protocol.ProtocolJson;
import io.github.yannisyoussef.qe.report.protocol.RunFinished;
import io.github.yannisyoussef.qe.report.protocol.SessionFinished;
import io.github.yannisyoussef.qe.report.protocol.SessionStarted;
import io.github.yannisyoussef.qe.report.protocol.SessionStatus;
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
import org.junit.jupiter.api.Nested;
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
  static final SessionStarted PRODUCER =
      new SessionStarted(
          new Component("test", "0"),
          new Component("fixture-runner", null),
          Map.of(),
          null,
          null,
          Map.of());

  static ReportSession.Builder session(Path dir, List<ReportProblem> problems) throws IOException {
    return ReportSession.builder("r", "s", FileSink.open(dir, "s"))
        .clock(new TickingClock())
        .ids(counter())
        .problems(problems::add);
  }

  static List<Event> events(Path dir) throws IOException {
    return Files.readString(dir.resolve("events").resolve(SessionFiles.fileName("s")))
        .lines()
        .map(ProtocolJson::read)
        .toList();
  }

  static List<String> types(Path dir) throws IOException {
    return events(dir).stream().map(Event::eventType).toList();
  }

  private static String run(Path dir, List<ReportProblem> problems) throws IOException {
    try (ReportSession s = session(dir, problems).start(PRODUCER)) {
      s.emit(new AttemptStarted("a-1", 1, TEST));
      s.attach(
          "a-1", null, "log", "text/plain", "password=hunter2".getBytes(StandardCharsets.UTF_8));
      s.emit(
          new AttemptFinished(
              "a-1", Status.FAILED, null, null, null, List.of(Failure.of("token=abc"))));
      s.finishRun();
      assertEquals(new ReportSession.Summary(6, 0), s.summary());
    }
    return Files.readString(dir.resolve("events").resolve(SessionFiles.fileName("s")));
  }

  @Test
  void deterministicForFixedClockAndIds(@TempDir Path a, @TempDir Path b) throws IOException {
    List<ReportProblem> problems = new ArrayList<>();
    String first = run(a, problems);
    assertEquals(first, run(b, problems));
    assertEquals(List.of(), problems);
    List<Event> events = events(a);
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
    AttachmentAdded att = assertInstanceOf(AttachmentAdded.class, events.get(2).payload());
    byte[] redacted = "password=[REDACTED]".getBytes(StandardCharsets.UTF_8);
    assertEquals(HexFormat.of().formatHex(FileSink.sha256().digest(redacted)), att.sha256());
    AttemptFinished fin = assertInstanceOf(AttemptFinished.class, events.get(3).payload());
    assertEquals("token=[REDACTED]", fin.failures().get(0).message());
  }

  @Nested
  class Lifecycle {
    @Test
    void activeThenSessionFinishedThenRunFinishedThenNothing(@TempDir Path dir) throws IOException {
      List<ReportProblem> problems = new ArrayList<>();
      ReportSession s = session(dir, problems).start(PRODUCER);
      assertEquals(ReportSession.State.ACTIVE, s.state());
      assertTrue(s.finish());
      assertEquals(ReportSession.State.SESSION_FINISHED, s.state());
      assertFalse(s.emit(new AttemptStarted("a", 1, TEST)));
      assertFalse(s.attach("a", null, "x", "text/plain", "y".getBytes(StandardCharsets.UTF_8)));
      assertFalse(s.finish());
      assertTrue(s.finishRun());
      assertEquals(ReportSession.State.RUN_FINISHED, s.state());
      assertFalse(s.finishRun());
      assertFalse(s.emit(new SessionFinished()));
      s.close();
      assertEquals(ReportSession.State.CLOSED, s.state());
      assertEquals(
          List.of(
              ReportProblem.Kind.SESSION_FINISHED,
              ReportProblem.Kind.SESSION_FINISHED,
              ReportProblem.Kind.SESSION_FINISHED,
              ReportProblem.Kind.RUN_FINISHED,
              ReportProblem.Kind.RUN_FINISHED),
          problems.stream().map(ReportProblem::kind).toList());
      assertEquals(List.of("session.started", "session.finished", "run.finished"), types(dir));
      assertEquals(
          List.of(),
          FileSinkTest.list(dir.resolve("attachments")),
          "nothing stored for a dropped attachment");
    }

    @Test
    void scopeFailuresAreSessionScoped(@TempDir Path dir) throws IOException {
      List<ReportProblem> problems = new ArrayList<>();
      ReportSession s = session(dir, problems).start(PRODUCER);
      io.github.yannisyoussef.qe.report.protocol.ScopeFailed failure =
          io.github.yannisyoussef.qe.report.protocol.ScopeFailed.of(
              List.of(new PathSegment("file", "suite.spec")), Failure.of("teardown token=abc"));
      assertTrue(s.emit(failure));
      assertTrue(s.finish());
      assertFalse(s.emit(failure), "no scope failure after session.finished");
      s.close();
      assertEquals(
          List.of(ReportProblem.Kind.SESSION_FINISHED),
          problems.stream().map(ReportProblem::kind).toList());
      List<Event> written = events(dir);
      assertEquals(
          List.of("session.started", "scope.failed", "session.finished"),
          written.stream().map(Event::eventType).toList());
      io.github.yannisyoussef.qe.report.protocol.ScopeFailed p =
          assertInstanceOf(
              io.github.yannisyoussef.qe.report.protocol.ScopeFailed.class,
              written.get(1).payload());
      assertEquals("teardown token=[REDACTED]", p.failures().get(0).message());
    }

    @Test
    void runFinishedFromAnActiveSessionFinishesTheSessionFirst(@TempDir Path dir)
        throws IOException {
      ReportSession s = session(dir, new ArrayList<>()).start(PRODUCER);
      assertTrue(s.emit(new RunFinished()));
      s.close();
      assertEquals(List.of("session.started", "session.finished", "run.finished"), types(dir));
    }

    @Test
    void closeFinishesAnActiveSessionAndAcceptsNothingAfterwards(@TempDir Path dir)
        throws IOException {
      List<ReportProblem> problems = new ArrayList<>();
      ReportSession s = session(dir, problems).start(PRODUCER);
      s.close();
      assertFalse(s.finishRun());
      assertEquals(
          List.of(ReportProblem.Kind.RUN_FINISHED),
          problems.stream().map(ReportProblem::kind).toList());
      assertEquals(List.of("session.started", "session.finished"), types(dir));
    }
  }

  @Nested
  class BoundedTextAttachments {
    @Test
    void storesATextFileAtTheLimitAndRefusesOneByteMore(@TempDir Path dir) throws IOException {
      List<ReportProblem> problems = new ArrayList<>();
      int limit = 100_000;
      try (ReportSession s =
          ReportSession.builder("r", "s", FileSink.open(dir, "s", limit))
              .clock(new TickingClock())
              .ids(counter())
              .problems(problems::add)
              .start(PRODUCER)) {
        s.emit(new AttemptStarted("a-1", 1, TEST));
        Path exact = dir.resolve("exact.txt");
        Path over = dir.resolve("over.txt");
        Files.writeString(exact, "x".repeat(limit));
        Files.writeString(over, "x".repeat(limit + 1));
        assertTrue(s.attach("a-1", null, "exact", "text/plain", exact));
        assertFalse(s.attach("a-1", null, "over", "text/plain", over));
      }
      assertEquals(
          List.of(ReportProblem.Kind.ATTACHMENT_TOO_LARGE),
          problems.stream().map(ReportProblem::kind).toList());
      assertEquals(1, FileSinkTest.list(dir.resolve("attachments")).size());
    }

    @Test
    void redactsATextFileBeforeHashingAndStreamsABinaryFileUntouched(@TempDir Path dir)
        throws IOException {
      try (ReportSession s = session(dir, new ArrayList<>()).start(PRODUCER)) {
        s.emit(new AttemptStarted("a-1", 1, TEST));
        Path text = dir.resolve("log.txt");
        Path bin = dir.resolve("img.png");
        Files.writeString(text, "Authorization: Bearer x");
        Files.write(bin, "password=notreallyapng".getBytes(StandardCharsets.UTF_8));
        assertTrue(s.attach("a-1", null, "log", "text/plain", text));
        assertTrue(s.attach("a-1", null, "../../evil", "image/png", bin));
      }
      List<String> stored = new ArrayList<>();
      for (String n : FileSinkTest.list(dir.resolve("attachments"))) {
        stored.add(Files.readString(dir.resolve("attachments").resolve(n)));
      }
      assertEquals(
          List.of("Authorization: [REDACTED]", "password=notreallyapng"),
          stored.stream().sorted().toList());
    }
  }

  @Test
  void binaryAttachmentsAreStoredUntouched(@TempDir Path dir) throws IOException {
    byte[] png = "password=notreallyapng".getBytes(StandardCharsets.UTF_8);
    try (ReportSession s = session(dir, new ArrayList<>()).start(PRODUCER)) {
      s.emit(new AttemptStarted("a-1", 1, TEST));
      assertTrue(s.attach("a-1", null, "../../etc/passwd", "image/png", png));
    }
    String hash = HexFormat.of().formatHex(FileSink.sha256().digest(png));
    assertArrayEquals(png, Files.readAllBytes(dir.resolve("attachments").resolve(hash)));
  }

  @Test
  void oversizedEventIsDroppedAndReported(@TempDir Path dir) throws IOException {
    List<ReportProblem> problems = new ArrayList<>();
    try (ReportSession s = session(dir, problems).maxEventBytes(400).start(PRODUCER)) {
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
          public long maxAttachmentBytes() {
            return 1;
          }

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
            .start(PRODUCER);
    assertFalse(s.attach("a", null, "x", "text/plain", "y".getBytes(StandardCharsets.UTF_8)));
    s.close();
    assertEquals(4, problems.size());
    assertTrue(problems.stream().allMatch(p -> p.kind() == ReportProblem.Kind.SINK_FAILURE));
  }

  @Test
  void eventLimitCannotBeRaised(@TempDir Path dir) throws IOException {
    try (FileSink sink = FileSink.open(dir, "s")) {
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
  }

  @Nested
  class SessionOutcome {
    @Test
    void finishWithOutcomeWritesItRedactedAndClosesTheSession(@TempDir Path dir)
        throws IOException {
      ReportSession s =
          ReportSession.builder("run-1", "s-1", FileSink.open(dir, "s-1"))
              .clock(new TickingClock())
              .start(SessionStarted.of(new Component("p", "1")));
      assertTrue(
          s.finish(
              new SessionFinished(
                  SessionStatus.FAILED,
                  "timedout",
                  List.of(
                      new Failure(
                          "global setup broke Authorization: Bearer abc.def.ghi",
                          "Error",
                          "at global-setup.ts:3 password=hunter2",
                          FailurePhase.SETUP,
                          null)))));
      assertFalse(s.finish(), "a second session.finished is dropped");
      List<Event> events = outcomeEvents(dir);
      SessionFinished p = assertInstanceOf(SessionFinished.class, events.get(1).payload());
      assertEquals(SessionStatus.FAILED, p.status());
      assertEquals("timedout", p.rawStatus());
      assertEquals("global setup broke Authorization: [REDACTED]", p.failures().get(0).message());
      assertEquals("at global-setup.ts:3 password=[REDACTED]", p.failures().get(0).stackTrace());
      assertEquals(FailurePhase.SETUP, p.failures().get(0).phase());
      s.close();
    }

    @Test
    void plainFinishStaysEmpty(@TempDir Path dir) throws IOException {
      ReportSession s =
          ReportSession.builder("run-1", "s-1", FileSink.open(dir, "s-1"))
              .clock(new TickingClock())
              .start(SessionStarted.of(new Component("p", "1")));
      assertTrue(s.finish());
      SessionFinished p =
          assertInstanceOf(SessionFinished.class, outcomeEvents(dir).get(1).payload());
      assertEquals(SessionFinished.empty(), p);
      s.close();
    }

    private List<Event> outcomeEvents(Path dir) throws IOException {
      Path file = dir.resolve("events").resolve(SessionFiles.fileName("s-1"));
      List<Event> out = new ArrayList<>();
      for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
        if (!line.isBlank()) {
          out.add(ProtocolJson.read(line));
        }
      }
      return out;
    }

    @Test
    void anOversizedOutcomeStillClosesTheSessionWithWhatFits(@TempDir Path dir) throws IOException {
      List<ReportProblem> problems = new ArrayList<>();
      ReportSession s = session(dir, problems).maxEventBytes(700).start(PRODUCER);
      assertTrue(
          s.finish(
              new SessionFinished(
                  SessionStatus.FAILED, "timedout", List.of(Failure.of("x".repeat(2_000))))));
      assertEquals(ReportSession.State.SESSION_FINISHED, s.state());
      s.close();
      SessionFinished p =
          assertInstanceOf(SessionFinished.class, readEventsOf(dir, "s").get(1).payload());
      assertEquals(new SessionFinished(SessionStatus.FAILED, "timedout", List.of()), p);
      assertEquals(
          List.of(ReportProblem.Kind.EVENT_TOO_LARGE, ReportProblem.Kind.EVENT_TOO_LARGE),
          problems.stream().map(ReportProblem::kind).toList());
    }

    private List<Event> readEventsOf(Path dir, String sessionId) throws IOException {
      Path file = dir.resolve("events").resolve(SessionFiles.fileName(sessionId));
      List<Event> out = new ArrayList<>();
      for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
        if (!line.isBlank()) {
          out.add(ProtocolJson.read(line));
        }
      }
      return out;
    }

    @Test
    void theModelRefusesAnOutcomeTheProtocolForbids() {
      assertThrows(
          IllegalArgumentException.class, () -> new SessionFinished(null, "failed", List.of()));
      assertThrows(
          IllegalArgumentException.class,
          () -> new SessionFinished(null, null, List.of(Failure.of("x"))));
      assertThrows(
          IllegalArgumentException.class,
          () -> new SessionFinished(SessionStatus.PASSED, null, List.of(Failure.of("x"))));
    }
  }
}
