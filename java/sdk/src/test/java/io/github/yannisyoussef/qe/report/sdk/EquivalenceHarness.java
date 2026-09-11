package io.github.yannisyoussef.qe.report.sdk;

import io.github.yannisyoussef.qe.report.protocol.AttemptFinished;
import io.github.yannisyoussef.qe.report.protocol.AttemptStarted;
import io.github.yannisyoussef.qe.report.protocol.Component;
import io.github.yannisyoussef.qe.report.protocol.Event;
import io.github.yannisyoussef.qe.report.protocol.Executor;
import io.github.yannisyoussef.qe.report.protocol.ExpectedStatus;
import io.github.yannisyoussef.qe.report.protocol.Failure;
import io.github.yannisyoussef.qe.report.protocol.FailurePhase;
import io.github.yannisyoussef.qe.report.protocol.HistoricalIdStability;
import io.github.yannisyoussef.qe.report.protocol.Location;
import io.github.yannisyoussef.qe.report.protocol.PathSegment;
import io.github.yannisyoussef.qe.report.protocol.ProtocolJson;
import io.github.yannisyoussef.qe.report.protocol.ScopeFailed;
import io.github.yannisyoussef.qe.report.protocol.SessionStarted;
import io.github.yannisyoussef.qe.report.protocol.Source;
import io.github.yannisyoussef.qe.report.protocol.Status;
import io.github.yannisyoussef.qe.report.protocol.StepFinished;
import io.github.yannisyoussef.qe.report.protocol.StepStarted;
import io.github.yannisyoussef.qe.report.protocol.TestCase;
import io.github.yannisyoussef.qe.report.protocol.testing.Corpus;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

/**
 * Produces the Java reference output for the cross-language equivalence check. The TypeScript
 * harness runs the same two scenarios; a test compares the outputs semantically. Test tooling, not
 * part of the published artifact.
 */
public final class EquivalenceHarness {
  private EquivalenceHarness() {}

  public static void main(String[] args) throws IOException {
    Path out = Path.of(args[0]);
    Path fixtures = Path.of(args[1]);
    deleteRecursively(out);
    for (String name : List.of("junit", "playwright", "karate", "forked")) {
      replay(fixtures.resolve("runs").resolve(name), out.resolve("replay").resolve(name));
    }
    scripted(out.resolve("scripted"));
  }

  /**
   * Parse every session file of a run with the binding and write it back through a sink of its own.
   */
  static void replay(Path runDir, Path out) throws IOException {
    FileSink last = null;
    for (Path file : Corpus.sessionFiles(runDir)) {
      List<Event> events = Corpus.lines(file).stream().map(ProtocolJson::read).toList();
      FileSink sink =
          FileSink.open(
              out, events.isEmpty() ? file.getFileName().toString() : events.get(0).sessionId());
      for (Event event : events) {
        sink.write(event);
      }
      if (last != null) {
        last.close();
      }
      last = sink;
    }
    FileSink sink = last != null ? last : FileSink.open(out, "attachments-only");
    Path attachments = runDir.resolve("attachments");
    if (Files.isDirectory(attachments)) {
      try (Stream<Path> files = Files.list(attachments)) {
        for (Path f : files.sorted().toList()) {
          try (InputStream in = Files.newInputStream(f)) {
            sink.storeAttachment(in);
          }
        }
      }
    }
    sink.close();
  }

  /** The same program as ts/packages/equivalence/src/scripted.ts. */
  static void scripted(Path out) throws IOException {
    Redactor redactor = Redactor.builder().sensitiveKey("otp").build();
    Map<String, String> fakeEnv = new LinkedHashMap<>();
    fakeEnv.put("CI", "true");
    fakeEnv.put("SECRET_TOKEN", "Bearer abc.def.ghi");
    fakeEnv.put("DB_URL", "postgres://user:pw@host/db");
    fakeEnv.put("HOME", "/home/nobody");
    AtomicInteger ids = new AtomicInteger();
    try (ReportSession s =
        ReportSession.builder("run-eq-0001", "session-eq-1", FileSink.open(out, "session-eq-1"))
            .clock(new ReportSessionTest.TickingClock())
            .ids(() -> String.format("evt-%04d", ids.incrementAndGet()))
            .redactor(redactor)
            .start(
                new SessionStarted(
                    new Component("equivalence-harness", "0.1.0"),
                    new Component("scripted", "1"),
                    EnvironmentCapture.fromMap(
                        fakeEnv, List.of("CI", "SECRET_TOKEN", "DB_URL", "MISSING"), redactor),
                    new Executor("local", "1", null),
                    new Source("https://example.invalid/r.git", "abc123", "develop"),
                    Map.of("team", "qa")))) {
      TestCase t1 =
          new TestCase(
              "t-1",
              "spec.ts::group::first",
              HistoricalIdStability.STABLE,
              "first test password=inname",
              List.of(
                  new PathSegment("project", "desktop"),
                  new PathSegment("file", "spec.ts"),
                  new PathSegment("group", "group")),
              new Location("spec.ts", 3L, 1L),
              List.of("@smoke", "token=tag"),
              Map.of("issue", "QE-1"));
      s.emit(new AttemptStarted("a-1", 1, t1));
      s.emit(
          new StepStarted(
              "st-1",
              "a-1",
              null,
              "outer secret: value",
              "test.step",
              new Location("spec.ts", 4L, null)));
      s.emit(new StepStarted("st-2", "a-1", "st-1", "inner", "expect", null));
      s.attach(
          "a-1",
          "st-2",
          "log",
          "text/plain",
          "Authorization: Bearer xyz\npassword=hunter2\notp=1234\n"
              .getBytes(StandardCharsets.UTF_8));
      s.attach(
          "a-1",
          null,
          "body",
          "application/json; charset=utf-8",
          "{\"token\":\"t1\",\"ok\":true}".getBytes(StandardCharsets.UTF_8));
      byte[] binary = new byte[256];
      for (int i = 0; i < binary.length; i++) {
        binary[i] = (byte) i;
      }
      s.attach("a-1", null, "../../evil.png", "image/png", binary);
      s.emit(
          new StepFinished(
              "st-2",
              "a-1",
              Status.FAILED,
              "failed",
              3L,
              List.of(Failure.of("expect failed token=abc"))));
      s.emit(new StepFinished("st-1", "a-1", Status.FAILED, null, 7L, List.of()));
      s.emit(
          new AttemptFinished(
              "a-1",
              Status.FAILED,
              "failed",
              null,
              42L,
              List.of(
                  new Failure(
                      "token=abc",
                      "AssertionError",
                      "at spec.ts:5 password=x",
                      FailurePhase.TEST,
                      new Location("spec.ts", 5L, 9L)))));
      s.emit(new AttemptStarted("a-2", 2, t1));
      s.emit(
          new AttemptFinished(
              "a-2", Status.PASSED, "passed", ExpectedStatus.FAILED, 1L, List.of()));
      TestCase t2 =
          new TestCase(
              "t-2",
              null,
              HistoricalIdStability.UNAVAILABLE,
              "dynamic #1",
              List.of(new PathSegment("file", "spec.ts")),
              null,
              List.of(),
              Map.of());
      s.emit(new AttemptStarted("a-3", 1, t2));
      s.emit(
          new AttemptFinished(
              "a-3", Status.SKIPPED, "aborted", null, null, List.of(Failure.of("assumption"))));
      s.emit(
          new ScopeFailed(
              List.of(new PathSegment("project", "desktop"), new PathSegment("file", "spec.ts")),
              "spec.ts",
              "failed",
              new Location("spec.ts", 1L, null),
              List.of(
                  new Failure(
                      "after hook failed password=secret",
                      "Error",
                      "at spec.ts:1 token=xyz",
                      FailurePhase.TEARDOWN,
                      null))));
      s.finishRun();
    }
  }

  private static void deleteRecursively(Path dir) throws IOException {
    if (!Files.exists(dir)) {
      return;
    }
    try (Stream<Path> s = Files.walk(dir)) {
      s.sorted((a, b) -> b.compareTo(a))
          .forEach(
              p -> {
                try {
                  Files.delete(p);
                } catch (IOException e) {
                  throw new UncheckedIOException(e);
                }
              });
    }
  }
}
