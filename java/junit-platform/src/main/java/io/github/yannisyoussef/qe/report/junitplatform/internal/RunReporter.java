package io.github.yannisyoussef.qe.report.junitplatform.internal;

import io.github.yannisyoussef.qe.report.protocol.AttemptFinished;
import io.github.yannisyoussef.qe.report.protocol.AttemptStarted;
import io.github.yannisyoussef.qe.report.protocol.Component;
import io.github.yannisyoussef.qe.report.protocol.Failure;
import io.github.yannisyoussef.qe.report.protocol.FailurePhase;
import io.github.yannisyoussef.qe.report.protocol.SessionStarted;
import io.github.yannisyoussef.qe.report.protocol.Status;
import io.github.yannisyoussef.qe.report.protocol.TestCase;
import io.github.yannisyoussef.qe.report.sdk.ReportSession;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.LongSupplier;
import org.jspecify.annotations.Nullable;
import org.junit.platform.engine.TestExecutionResult;
import org.junit.platform.engine.reporting.ReportEntry;
import org.junit.platform.launcher.Launcher;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;

/**
 * Turns the lifecycle of one test plan into attempts of one session. Safe under concurrent
 * callbacks: state lives in concurrent maps keyed by unique id, and the SDK serialises writes.
 *
 * <p>State is bounded to open attempts, open containers, and one counter per test that has executed
 * in this plan (needed to number repeated executions of the same unique id).
 */
public final class RunReporter {
  static final String PRODUCER_NAME = "qe-report-junit-platform";
  static final String RUNNER_NAME = "junit-platform";
  static final String REPORT_ENTRY_NAME = "junit-report-entry";
  static final String RAW_SKIPPED = "SKIPPED";

  private record OpenAttempt(String attemptId, long startedAt) {}

  private static final class OpenContainer {
    final AtomicInteger startedTests = new AtomicInteger();
  }

  private final ReportSession session;
  private final LongSupplier ticker;
  private final Diagnostics diagnostics;
  private volatile @Nullable TestPlan plan;
  private final ConcurrentMap<String, OpenAttempt> open = new ConcurrentHashMap<>();
  private final ConcurrentMap<String, OpenContainer> containers = new ConcurrentHashMap<>();
  private final ConcurrentMap<String, AtomicInteger> executions = new ConcurrentHashMap<>();

  public RunReporter(
      ReportSession session, TestPlan plan, LongSupplier ticker, Diagnostics diagnostics) {
    this.session = session;
    this.plan = plan;
    this.ticker = ticker;
    this.diagnostics = diagnostics;
  }

  /** The session.started payload: adapter and runner identity, and the Java version. */
  public static SessionStarted sessionStarted() {
    return new SessionStarted(
        new Component(PRODUCER_NAME, adapterVersion()),
        new Component(RUNNER_NAME, Launcher.class.getPackage().getImplementationVersion()),
        Map.of("java.version", System.getProperty("java.version", "unknown")),
        null,
        null,
        Map.of());
  }

  static @Nullable String adapterVersion() {
    try (InputStream in =
        RunReporter.class.getResourceAsStream(
            "/io/github/yannisyoussef/qe/report/junitplatform/adapter.properties")) {
      if (in == null) {
        return null;
      }
      Properties p = new Properties();
      p.load(in);
      String v = p.getProperty("version");
      return v == null || v.startsWith("$") ? null : v;
    } catch (IOException e) {
      return null;
    }
  }

  public void started(TestIdentifier id) {
    TestPlan p = plan();
    if (id.isContainer()) {
      containers.put(id.getUniqueId(), new OpenContainer());
      return;
    }
    if (!id.isTest()) {
      return;
    }
    for (Optional<TestIdentifier> c = p.getParent(id); c.isPresent(); c = p.getParent(c.get())) {
      OpenContainer oc = containers.get(c.get().getUniqueId());
      if (oc != null) {
        oc.startedTests.incrementAndGet();
      }
    }
    startAttempt(p, id);
  }

  public void finished(TestIdentifier id, TestExecutionResult result) {
    TestPlan p = plan();
    if (id.isTest()) {
      OpenAttempt attempt = open.remove(id.getUniqueId());
      if (attempt == null) {
        diagnostics.once(
            "finish-without-start:" + id.getUniqueId(),
            "finished without a start: " + id.getUniqueId());
        return;
      }
      long durationMs = Math.max(0, (ticker.getAsLong() - attempt.startedAt()) / 1_000_000);
      session.emit(
          new AttemptFinished(
              attempt.attemptId(),
              JunitMapper.status(result.getStatus()),
              result.getStatus().name(),
              null,
              durationMs,
              JunitMapper.failures(result.getThrowable().orElse(null))));
      return;
    }
    OpenContainer container = containers.remove(id.getUniqueId());
    if (result.getStatus() != TestExecutionResult.Status.FAILED) {
      return;
    }
    Throwable cause = result.getThrowable().orElse(null);
    Set<TestIdentifier> planned = p.getDescendants(id);
    long plannedTests = planned.stream().filter(TestIdentifier::isTest).count();
    if (container != null && container.startedTests.get() == 0 && plannedTests > 0) {
      // Shared set-up failed before any planned test could start: each planned test is reported
      // as prevented by set-up, with the container's failure. See the adapter documentation.
      Failure failure =
          cause == null
              ? Failure.of("container " + id.getDisplayName() + " failed")
              : JunitMapper.failure(cause, FailurePhase.SETUP);
      for (TestIdentifier t : planned) {
        if (t.isTest()) {
          synthesize(p, t, Status.FAILED, "FAILED", List.of(failure));
        }
      }
      return;
    }
    // Container failed after its tests ran (a JUnit @AfterAll, for example). Protocol 0.1 has no
    // event for a failure that belongs to no test; it is not hidden and not attributed to a test.
    diagnostics.once(
        "container-failure:" + id.getUniqueId(),
        "container '"
            + id.getDisplayName()
            + "' failed after its tests completed; protocol 0.1 cannot represent a container-level failure, so the run does not record it",
        cause);
  }

  public void skipped(TestIdentifier id, String reason) {
    TestPlan p = plan();
    List<Failure> why =
        reason == null || reason.isBlank()
            ? List.of()
            : List.of(Failure.of(Texts.bounded(reason, Texts.MAX_MESSAGE)));
    if (id.isTest()) {
      synthesize(p, id, Status.SKIPPED, RAW_SKIPPED, why);
      return;
    }
    // A skipped container hides its planned children from the listener; they are reported as
    // skipped so that the count of planned tests stays honest.
    for (TestIdentifier t : p.getDescendants(id)) {
      if (t.isTest()) {
        synthesize(p, t, Status.SKIPPED, RAW_SKIPPED, why);
      }
    }
  }

  public void reportingEntry(TestIdentifier id, ReportEntry entry) {
    OpenAttempt attempt = open.get(id.getUniqueId());
    if (attempt == null) {
      diagnostics.once(
          "entry-without-attempt:" + id.getUniqueId(),
          "report entry published outside a test attempt is not recorded: " + id.getDisplayName());
      return;
    }
    StringBuilder text = new StringBuilder();
    text.append("timestamp: ").append(entry.getTimestamp()).append('\n');
    for (Map.Entry<String, String> e : entry.getKeyValuePairs().entrySet()) {
      text.append(e.getKey()).append(": ").append(e.getValue()).append('\n');
    }
    session.attach(
        attempt.attemptId(),
        null,
        REPORT_ENTRY_NAME,
        "text/plain",
        text.toString().getBytes(StandardCharsets.UTF_8));
  }

  public void finish() {
    if (!open.isEmpty()) {
      diagnostics.once(
          "open-at-finish", open.size() + " test(s) never finished before the plan ended");
    }
    session.close();
    plan = null;
    open.clear();
    containers.clear();
    executions.clear();
  }

  private void startAttempt(TestPlan p, TestIdentifier id) {
    TestCase test = JunitMapper.testCase(p, id);
    int number =
        executions.computeIfAbsent(test.executionId(), k -> new AtomicInteger()).incrementAndGet();
    String attemptId = test.executionId() + "-" + number;
    open.put(id.getUniqueId(), new OpenAttempt(attemptId, ticker.getAsLong()));
    session.emit(new AttemptStarted(attemptId, number, test));
  }

  private void synthesize(
      TestPlan p, TestIdentifier id, Status status, String rawStatus, List<Failure> failures) {
    TestCase test = JunitMapper.testCase(p, id);
    int number =
        executions.computeIfAbsent(test.executionId(), k -> new AtomicInteger()).incrementAndGet();
    String attemptId = test.executionId() + "-" + number;
    session.emit(new AttemptStarted(attemptId, number, test));
    session.emit(new AttemptFinished(attemptId, status, rawStatus, null, null, failures));
  }

  private TestPlan plan() {
    TestPlan p = plan;
    if (p == null) {
      throw new IllegalStateException("no test plan is being reported");
    }
    return p;
  }
}
