package io.github.yannisyoussef.qe.report.junitplatform;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.yannisyoussef.qe.report.protocol.Event;
import io.github.yannisyoussef.qe.report.protocol.ProtocolJson;
import io.github.yannisyoussef.qe.report.protocol.testing.Corpus;
import io.github.yannisyoussef.qe.report.protocol.testing.Schemas;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/**
 * Real consumer builds resolve the adapter from the build-local repository and discover it through
 * ServiceLoader. Each fork of the consumer becomes one session of one run directory, which the
 * TypeScript validator checks afterwards from {@code build/consumer-runs}.
 */
@Tag("consumer")
class ConsumerFixturesTest {
  private static final Path FIXTURES = Path.of(System.getProperty("qe.consumerFixtures"));
  private static final Path RUNS = Path.of(System.getProperty("qe.consumerRuns"));
  private static final String LOCAL_REPO = System.getProperty("qe.localRepo");
  private static final int CLASSES = 6;
  private static final int ATTEMPTS_PER_CLASS = 5;

  @Test
  void gradleForksShareOneRunDirectory() throws Exception {
    Path run = fresh("gradle");
    Path cache = Files.createTempDirectory("qe-gradle-cache");
    List<String> command =
        List.of(
            System.getProperty("qe.gradleWrapper"),
            "-p",
            FIXTURES.resolve("gradle").toString(),
            "test",
            "--no-daemon",
            "-q",
            "--project-cache-dir",
            cache.toString(),
            "-Pqe.localRepo=" + LOCAL_REPO,
            "-Pqe.report.dir=" + run,
            "-Pqe.report.runId=run-gradle-consumer");
    execute(command, FIXTURES.resolve("gradle"));
    assertRun(run, 3, "run-gradle-consumer");
  }

  @Test
  void surefireForksShareOneRunDirectory() throws Exception {
    Path run = fresh("maven");
    List<String> command =
        List.of(
            FIXTURES.resolve("maven").resolve("mvnw").toString(),
            "-q",
            "-B",
            "test",
            "-Dqe.localRepo=file://" + LOCAL_REPO,
            "-Dqe.report.dir=" + run,
            "-Dqe.report.runId=run-maven-consumer");
    String output = execute(command, FIXTURES.resolve("maven"));
    assertTrue(output.contains("qe-report-junit-platform: writing run run-maven-consumer"), output);
    assertRun(run, CLASSES, "run-maven-consumer");
  }

  private static Path fresh(String name) throws IOException {
    Path run = RUNS.resolve(name);
    if (Files.exists(run)) {
      try (Stream<Path> s = Files.walk(run)) {
        s.sorted((a, b) -> b.compareTo(a)).forEach(p -> p.toFile().delete());
      }
    }
    Files.createDirectories(RUNS);
    return run;
  }

  private static String execute(List<String> command, Path directory) throws Exception {
    Process p =
        new ProcessBuilder(command).directory(directory.toFile()).redirectErrorStream(true).start();
    String output = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    assertTrue(p.waitFor(15, TimeUnit.MINUTES), "consumer build finished");
    assertEquals(0, p.exitValue(), () -> String.join(" ", command) + "\n" + output);
    return output;
  }

  /** Structural checks in Java; the TypeScript validator checks the same directory in CI. */
  private static void assertRun(Path run, int expectedSessions, String runId) throws IOException {
    List<Path> files = Corpus.sessionFiles(run);
    assertEquals(expectedSessions, files.size(), "one session file per fork: " + files);
    Set<String> sessions = new HashSet<>();
    int attempts = 0;
    for (Path file : files) {
      long expectedSequence = 1;
      Set<String> inFile = new HashSet<>();
      List<Event> events = new ArrayList<>();
      for (String line : Corpus.lines(file)) {
        assertTrue(Schemas.isValid(line), () -> Schemas.describe(Schemas.errors(line)));
        Event e = ProtocolJson.read(line);
        assertEquals(runId, e.runId());
        assertEquals(
            expectedSequence++, e.sequence(), "contiguous sequence in " + file.getFileName());
        inFile.add(e.sessionId());
        events.add(e);
      }
      assertEquals(1, inFile.size(), "one session per file");
      assertEquals("session.started", events.get(0).eventType());
      assertEquals(
          "session.finished",
          events.get(events.size() - 1).eventType(),
          "a fork finishes its session and never the run");
      assertTrue(events.stream().noneMatch(e -> e.eventType().equals("run.finished")));
      attempts +=
          (int) events.stream().filter(e -> e.eventType().equals("attempt.finished")).count();
      sessions.addAll(inFile);
    }
    assertEquals(expectedSessions, sessions.size());
    assertEquals(CLASSES * ATTEMPTS_PER_CLASS, attempts);
    Files.writeString(
        run.resolve("expectations.json"),
        "{\"sessions\": "
            + expectedSessions
            + ", \"attempts\": "
            + attempts
            + ", \"closed\": false}\n",
        StandardCharsets.UTF_8);
  }
}
