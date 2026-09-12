package io.github.yannisyoussef.qe.report.junitplatform;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.yannisyoussef.qe.report.junitplatform.internal.AdapterConfig;
import io.github.yannisyoussef.qe.report.sdk.RunDirectories;
import io.github.yannisyoussef.qe.report.sdk.SessionFiles;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.platform.launcher.listeners.TestExecutionSummary;

/** Whatever goes wrong with reporting, the launcher's own results are untouched. */
class FailureIsolationTest {
  private static final Class<?>[] SUITE = {
    qe.fixtures.PassingTests.class, qe.fixtures.FailingTests.class
  };

  record Outcome(TestExecutionSummary summary, String log) {}

  private static Outcome run(AdapterConfig config, java.util.function.LongSupplier ticker) {
    ByteArrayOutputStream log = new ByteArrayOutputStream();
    QeReportListener listener =
        new QeReportListener(
            () -> config,
            ticker,
            new LauncherRuns.TickingClock(),
            new PrintStream(log, true, StandardCharsets.UTF_8));
    TestExecutionSummary summary = LauncherRuns.execute(listener, Map.of(), SUITE);
    return new Outcome(summary, log.toString(StandardCharsets.UTF_8));
  }

  private static void assertResultsUntouched(Outcome o) {
    assertEquals(6, o.summary().getTestsFoundCount());
    assertEquals(3, o.summary().getTestsSucceededCount());
    assertEquals(3, o.summary().getTestsFailedCount());
  }

  @Test
  void outputDirectoryCannotBeCreated(@TempDir Path dir) throws Exception {
    Path file = dir.resolve("not-a-directory");
    Files.writeString(file, "occupied");
    Outcome o = run(new AdapterConfig(true, file, "r", "s", List.of()), System::nanoTime);
    assertResultsUntouched(o);
    assertTrue(o.log().contains("cannot start reporting"), o.log());
    assertEquals(
        1,
        o.log().lines().filter(l -> l.contains("cannot start reporting")).count(),
        "reported once, not per test");
  }

  @Test
  void sessionFileAlreadyExists(@TempDir Path dir) throws Exception {
    Files.createDirectories(RunDirectories.resolve(dir, "r").resolve("events"));
    Files.writeString(
        RunDirectories.resolve(dir, "r").resolve("events").resolve(SessionFiles.fileName("s")),
        "{}\n");
    Outcome o = run(new AdapterConfig(true, dir, "r", "s", List.of()), System::nanoTime);
    assertResultsUntouched(o);
    assertTrue(o.log().contains("cannot start reporting"), o.log());
    assertEquals(
        "{}\n",
        Files.readString(
            RunDirectories.resolve(dir, "r").resolve("events").resolve(SessionFiles.fileName("s"))),
        "the existing file is never touched");
  }

  @Test
  void attachmentCannotBeWritten(@TempDir Path dir) throws Exception {
    Path attachments = RunDirectories.resolve(dir, "r").resolve("attachments");
    Files.createDirectories(attachments);
    assertTrue(attachments.toFile().setWritable(false, false), "test needs a read-only directory");
    try {
      ByteArrayOutputStream log = new ByteArrayOutputStream();
      QeReportListener listener =
          new QeReportListener(
              () -> new AdapterConfig(true, dir, "r", "s", List.of()),
              System::nanoTime,
              new LauncherRuns.TickingClock(),
              new PrintStream(log, true, StandardCharsets.UTF_8));
      TestExecutionSummary summary =
          LauncherRuns.execute(listener, Map.of(), qe.fixtures.ReportingTests.class);
      assertEquals(1, summary.getTestsSucceededCount());
      String text = log.toString(StandardCharsets.UTF_8);
      assertTrue(text.contains("SINK_FAILURE: cannot store attachment"), text);
      List<String> lines =
          Files.readAllLines(
              RunDirectories.resolve(dir, "r")
                  .resolve("events")
                  .resolve(SessionFiles.fileName("s")));
      assertTrue(
          lines.stream().anyMatch(l -> l.contains("\"attempt.finished\"")),
          "the attempt still finished");
      assertFalse(
          lines.stream().anyMatch(l -> l.contains("\"attachment.added\"")),
          "no attachment event without bytes");
    } finally {
      attachments.toFile().setWritable(true, false);
    }
  }

  @Test
  void malformedOptionalMetadataIsNotedAndDefaulted(@TempDir Path dir) {
    java.util.Properties p = new java.util.Properties();
    p.setProperty(AdapterConfig.ENABLED_PROPERTY, "maybe");
    p.setProperty(AdapterConfig.SESSION_ID_PROPERTY, "has spaces");
    p.setProperty(AdapterConfig.RUN_ID_PROPERTY, "x".repeat(129));
    p.setProperty(AdapterConfig.DIR_PROPERTY, dir.toString());
    AdapterConfig config = AdapterConfig.resolve(p, Map.of());
    assertTrue(config.enabled());
    assertTrue(config.sessionId().startsWith("junit-"));
    assertTrue(config.runId().startsWith("run-"));
    assertEquals(4, config.notes().size(), config.notes().toString());
    Outcome o = run(config, System::nanoTime);
    assertResultsUntouched(o);
    assertTrue(o.log().contains("unrecognised value 'maybe'"), o.log());
    assertTrue(
        Files.exists(
            config
                .runDirectory()
                .resolve("events")
                .resolve(SessionFiles.fileName(config.sessionId()))));
  }

  @Test
  void internalMappingProblemIsContained(@TempDir Path dir) throws Exception {
    Outcome o =
        run(
            new AdapterConfig(true, dir, "r", "s", List.of()),
            () -> {
              throw new IllegalStateException("clock broke");
            });
    assertResultsUntouched(o);
    assertTrue(o.log().contains("internal error while reporting an execution start"), o.log());
    assertEquals(
        1,
        o.log()
            .lines()
            .filter(l -> l.contains("internal error while reporting an execution start"))
            .count());
    List<String> lines =
        Files.readAllLines(
            RunDirectories.resolve(dir, "r").resolve("events").resolve(SessionFiles.fileName("s")));
    assertTrue(lines.get(0).contains("\"session.started\""));
    assertTrue(
        lines.get(lines.size() - 1).contains("\"session.finished\""),
        "the session is still closed cleanly");
  }

  @Test
  void disabledReportingWritesNothing(@TempDir Path dir) {
    Outcome o = run(new AdapterConfig(false, dir, "r", "s", List.of()), System::nanoTime);
    assertResultsUntouched(o);
    assertTrue(o.log().contains("reporting is disabled"), o.log());
    assertFalse(Files.exists(dir.resolve("runs")));
  }
}
