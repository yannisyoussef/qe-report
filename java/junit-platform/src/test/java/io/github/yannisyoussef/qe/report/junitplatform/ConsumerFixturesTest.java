package io.github.yannisyoussef.qe.report.junitplatform;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.yannisyoussef.qe.report.protocol.AttemptFinished;
import io.github.yannisyoussef.qe.report.protocol.Event;
import io.github.yannisyoussef.qe.report.protocol.ProtocolJson;
import io.github.yannisyoussef.qe.report.protocol.ScopeFailed;
import io.github.yannisyoussef.qe.report.protocol.Status;
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

  /** Six classes over three forks, two each, so {@code forkEvery} never restarts a fork. */
  private static final int GRADLE_FORKS = 3;

  /** CharlieTest fails one test on purpose; FoxtrotTest fails in {@code @AfterAll}. */
  private static final int FAILED_ATTEMPTS = 1;

  private static final int SCOPE_FAILURES = 1;

  /**
   * Gradle reads a file repository in place and does not cache it, so the adapter published by this
   * checkout is the one resolved; the Maven build below needs a repository of its own for that.
   */
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
    assertRun(run, GRADLE_FORKS, "run-gradle-consumer");
  }

  @Test
  void surefireForksShareOneRunDirectory() throws Exception {
    Path run = fresh("maven");
    // Maven never fetches a release version it already holds, so the build gets a repository of
    // its own under the build directory, and the adapter published by this checkout is removed
    // from it before every run. Nothing outside the build directory is touched.
    Path repository = RUNS.resolveSibling("consumer-maven-repository");
    delete(repository.resolve("io").resolve("github").resolve("yannisyoussef"));
    List<String> command =
        List.of(
            FIXTURES.resolve("maven").resolve("mvnw").toString(),
            "-q",
            "-B",
            "test",
            "-Dmaven.repo.local=" + repository,
            "-Dqe.localRepo=file://" + LOCAL_REPO,
            "-Dqe.report.dir=" + run,
            "-Dqe.report.runId=run-maven-consumer");
    String output = execute(command, FIXTURES.resolve("maven"));
    assertTrue(output.contains("qe-report-junit-platform: writing run run-maven-consumer"), output);
    assertRun(run, CLASSES, "run-maven-consumer");
  }

  private static Path fresh(String name) throws IOException {
    Path run = RUNS.resolve(name);
    delete(run);
    Files.createDirectories(RUNS);
    return run;
  }

  private static void delete(Path directory) throws IOException {
    if (Files.exists(directory)) {
      try (Stream<Path> s = Files.walk(directory)) {
        s.sorted((a, b) -> b.compareTo(a)).forEach(p -> p.toFile().delete());
      }
    }
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
    int failedAttempts = 0;
    int scopeFailures = 0;
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
      for (Event e : events) {
        if (e.payload() instanceof AttemptFinished f) {
          attempts++;
          if (f.status() == Status.FAILED) {
            failedAttempts++;
          }
        } else if (e.payload() instanceof ScopeFailed) {
          scopeFailures++;
        }
      }
      sessions.addAll(inFile);
    }
    assertEquals(expectedSessions, sessions.size());
    assertEquals(CLASSES * ATTEMPTS_PER_CLASS, attempts, "a scope failure invents no attempt");
    assertEquals(FAILED_ATTEMPTS, failedAttempts);
    assertEquals(SCOPE_FAILURES, scopeFailures);
    Files.writeString(
        run.resolve("expectations.json"),
        "{\"sessions\": "
            + expectedSessions
            + ", \"attempts\": "
            + attempts
            + ", \"failedAttempts\": "
            + failedAttempts
            + ", \"scopeFailures\": "
            + scopeFailures
            + ", \"verdict\": \""
            + (failedAttempts > 0 || scopeFailures > 0 ? "failed" : "passed")
            + "\", \"closed\": false}\n",
        StandardCharsets.UTF_8);
  }
}
