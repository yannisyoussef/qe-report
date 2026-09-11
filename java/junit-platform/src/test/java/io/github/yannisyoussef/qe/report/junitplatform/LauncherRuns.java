package io.github.yannisyoussef.qe.report.junitplatform;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.yannisyoussef.qe.report.junitplatform.internal.AdapterConfig;
import io.github.yannisyoussef.qe.report.protocol.AttemptFinished;
import io.github.yannisyoussef.qe.report.protocol.AttemptStarted;
import io.github.yannisyoussef.qe.report.protocol.Event;
import io.github.yannisyoussef.qe.report.protocol.ProtocolJson;
import io.github.yannisyoussef.qe.report.protocol.ScopeFailed;
import io.github.yannisyoussef.qe.report.protocol.testing.Schemas;
import io.github.yannisyoussef.qe.report.sdk.SessionFiles;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import org.jspecify.annotations.Nullable;
import org.junit.platform.launcher.Launcher;
import org.junit.platform.launcher.LauncherDiscoveryRequest;
import org.junit.platform.launcher.core.LauncherConfig;
import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder;
import org.junit.platform.launcher.core.LauncherFactory;
import org.junit.platform.launcher.listeners.SummaryGeneratingListener;
import org.junit.platform.launcher.listeners.TestExecutionSummary;

/** Runs fixture classes through the real Launcher with an explicitly configured adapter. */
final class LauncherRuns {
  static final String RUN_ID = "run-adapter-test";

  /** One executed attempt: its start, its finish, and its attachments. */
  record Attempt(AttemptStarted started, AttemptFinished finished, List<Event> attachments) {}

  record Result(
      Path dir, String sessionId, List<Event> events, String log, TestExecutionSummary summary) {
    Path eventFile() {
      return dir.resolve("events").resolve(SessionFiles.fileName(sessionId));
    }

    Map<String, Attempt> attempts() {
      Map<String, AttemptStarted> starts = new LinkedHashMap<>();
      Map<String, List<Event>> attachments = new LinkedHashMap<>();
      Map<String, Attempt> out = new LinkedHashMap<>();
      for (Event e : events) {
        if (e.payload() instanceof AttemptStarted s) {
          starts.put(s.attemptId(), s);
        } else if (e.payload()
            instanceof io.github.yannisyoussef.qe.report.protocol.AttachmentAdded a) {
          attachments.computeIfAbsent(a.attemptId(), k -> new ArrayList<>()).add(e);
        } else if (e.payload() instanceof AttemptFinished f) {
          AttemptStarted s = starts.remove(f.attemptId());
          assertTrue(s != null, "finished before started: " + f.attemptId());
          out.put(
              f.attemptId(), new Attempt(s, f, attachments.getOrDefault(f.attemptId(), List.of())));
        }
      }
      assertEquals(Map.of(), starts, "every started attempt finished");
      return out;
    }

    /** Attempts whose display name equals the given name. */
    List<Attempt> named(String displayName) {
      return attempts().values().stream()
          .filter(a -> a.started().test().displayName().equals(displayName))
          .toList();
    }

    Attempt one(String displayName) {
      List<Attempt> found = named(displayName);
      assertEquals(1, found.size(), "exactly one attempt named " + displayName + " in " + names());
      return found.get(0);
    }

    List<String> names() {
      return attempts().values().stream().map(a -> a.started().test().displayName()).toList();
    }

    /** The redacted text of every text attachment written by this run. */
    List<String> attachmentTexts() {
      List<String> out = new ArrayList<>();
      for (Event e : events) {
        if (e.payload() instanceof io.github.yannisyoussef.qe.report.protocol.AttachmentAdded a
            && a.mediaType().startsWith("text/")) {
          try {
            out.add(
                Files.readString(
                    dir.resolve("attachments").resolve(a.sha256()), StandardCharsets.UTF_8));
          } catch (java.io.IOException ex) {
            throw new java.io.UncheckedIOException(ex);
          }
        }
      }
      return out;
    }

    /** Every scope.failed of the run, in emission order. */
    List<ScopeFailed> scopeFailures() {
      return events.stream()
          .map(Event::payload)
          .filter(ScopeFailed.class::isInstance)
          .map(ScopeFailed.class::cast)
          .toList();
    }

    Optional<Event> sessionStarted() {
      return events.stream().filter(e -> e.eventType().equals("session.started")).findFirst();
    }
  }

  static final class TickingClock extends Clock {
    private Instant now = Instant.parse("2026-01-01T00:00:00Z");

    @Override
    public java.time.ZoneId getZone() {
      return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(java.time.ZoneId zone) {
      return this;
    }

    @Override
    public synchronized Instant instant() {
      Instant current = now;
      now = now.plusMillis(1);
      return current;
    }
  }

  static Result run(Path dir, Class<?>... classes) {
    return run(dir, Map.of(), null, classes);
  }

  static Result runParallel(Path dir, Class<?>... classes) {
    return run(
        dir,
        Map.of(
            "junit.jupiter.execution.parallel.enabled", "true",
            "junit.jupiter.execution.parallel.mode.default", "concurrent",
            "junit.jupiter.execution.parallel.mode.classes.default", "concurrent"),
        null,
        classes);
  }

  static Result run(
      Path dir,
      Map<String, String> configuration,
      @Nullable LongSupplier ticker,
      Class<?>... classes) {
    String sessionId = "test-session";
    Supplier<AdapterConfig> config =
        () -> new AdapterConfig(true, dir, RUN_ID, sessionId, List.of());
    ByteArrayOutputStream logBytes = new ByteArrayOutputStream();
    QeReportListener listener =
        new QeReportListener(
            config,
            ticker != null ? ticker : System::nanoTime,
            new TickingClock(),
            new PrintStream(logBytes, true, StandardCharsets.UTF_8));
    TestExecutionSummary summary = execute(listener, configuration, classes);
    Path file = dir.resolve("events").resolve(SessionFiles.fileName(sessionId));
    List<Event> events = new ArrayList<>();
    if (Files.exists(file)) {
      try {
        for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
          if (line.isBlank()) {
            continue;
          }
          assertTrue(
              Schemas.isValid(line),
              () ->
                  "schema-invalid event: " + Schemas.describe(Schemas.errors(line)) + "\n" + line);
          events.add(ProtocolJson.read(line));
        }
      } catch (java.io.IOException e) {
        throw new java.io.UncheckedIOException(e);
      }
    }
    long expected = 1;
    for (Event e : events) {
      assertEquals(expected++, e.sequence(), "contiguous sequence");
    }
    return new Result(dir, sessionId, events, logBytes.toString(StandardCharsets.UTF_8), summary);
  }

  /** Executes with the adapter registered explicitly and automatic registration off. */
  static TestExecutionSummary execute(
      QeReportListener listener, Map<String, String> configuration, Class<?>... classes) {
    Launcher launcher =
        LauncherFactory.create(
            LauncherConfig.builder()
                .enableTestExecutionListenerAutoRegistration(false)
                .addTestExecutionListeners(listener)
                .build());
    SummaryGeneratingListener summary = new SummaryGeneratingListener();
    launcher.execute(request(configuration, classes), summary);
    return summary.getSummary();
  }

  static LauncherDiscoveryRequest request(Map<String, String> configuration, Class<?>... classes) {
    LauncherDiscoveryRequestBuilder b = LauncherDiscoveryRequestBuilder.request();
    for (Class<?> c : classes) {
      b.selectors(org.junit.platform.engine.discovery.DiscoverySelectors.selectClass(c));
    }
    configuration.forEach(b::configurationParameter);
    return b.build();
  }
}
