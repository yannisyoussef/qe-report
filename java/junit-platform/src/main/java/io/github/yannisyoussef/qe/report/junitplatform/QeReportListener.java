package io.github.yannisyoussef.qe.report.junitplatform;

import io.github.yannisyoussef.qe.report.junitplatform.internal.AdapterConfig;
import io.github.yannisyoussef.qe.report.junitplatform.internal.Diagnostics;
import io.github.yannisyoussef.qe.report.junitplatform.internal.RunReporter;
import io.github.yannisyoussef.qe.report.sdk.FileSink;
import io.github.yannisyoussef.qe.report.sdk.ReportSession;
import java.io.PrintStream;
import java.time.Clock;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import org.jspecify.annotations.Nullable;
import org.junit.platform.engine.TestExecutionResult;
import org.junit.platform.engine.reporting.ReportEntry;
import org.junit.platform.launcher.TestExecutionListener;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;

/**
 * Reports a JUnit Platform execution as one qe-report session per test plan.
 *
 * <p>Registered through {@code META-INF/services}; the launcher instantiates it with the
 * no-argument constructor. Configuration comes from {@code qe.report.*} system properties and
 * {@code QE_REPORT_*} environment variables. Nothing here can change a test result: every callback
 * contains its own failures, and an unrecoverable start-up problem turns the listener into a
 * visible no-op for the rest of the plan.
 */
public final class QeReportListener implements TestExecutionListener {
  private final Supplier<AdapterConfig> config;
  private final LongSupplier ticker;
  private final Clock clock;
  private final Diagnostics diagnostics;
  private int plansStarted;
  private volatile @Nullable RunReporter reporter;

  /** Used by {@code ServiceLoader}. */
  public QeReportListener() {
    this(AdapterConfig::fromSystem, System::nanoTime, Clock.systemUTC(), System.err);
  }

  QeReportListener(
      Supplier<AdapterConfig> config, LongSupplier ticker, Clock clock, PrintStream log) {
    this.config = config;
    this.ticker = ticker;
    this.clock = clock;
    this.diagnostics = new Diagnostics(log);
  }

  @Override
  public synchronized void testPlanExecutionStarted(TestPlan testPlan) {
    if (reporter != null) {
      finishQuietly();
    }
    plansStarted++;
    try {
      AdapterConfig cfg = config.get();
      diagnostics.note(cfg.notes());
      if (!cfg.enabled()) {
        diagnostics.once("disabled", "reporting is disabled (qe.report.enabled)");
        return;
      }
      String sessionId = plansStarted == 1 ? cfg.sessionId() : cfg.sessionId() + "-" + plansStarted;
      FileSink sink = FileSink.open(cfg.runDirectory(), sessionId);
      ReportSession session =
          ReportSession.builder(cfg.runId(), sessionId, sink)
              .clock(clock)
              .problems(diagnostics::problem)
              .start(RunReporter.sessionStarted());
      reporter = new RunReporter(session, testPlan, ticker, diagnostics);
      diagnostics.once(
          "started",
          "writing run " + cfg.runId() + " session " + sessionId + " to " + sink.eventFile());
    } catch (RuntimeException | java.io.IOException e) {
      reporter = null;
      diagnostics.once("start-failed", "cannot start reporting; this plan will not be reported", e);
    }
  }

  @Override
  public void testPlanExecutionFinished(TestPlan testPlan) {
    finishQuietly();
  }

  @Override
  public void dynamicTestRegistered(TestIdentifier testIdentifier) {
    // Nothing to record until the test starts; the plan already knows the new identifier.
  }

  @Override
  public void executionSkipped(TestIdentifier testIdentifier, String reason) {
    RunReporter r = reporter;
    if (r == null) {
      return;
    }
    try {
      r.skipped(testIdentifier, reason);
    } catch (RuntimeException e) {
      diagnostics.once("internal", "internal error while reporting a skipped execution", e);
    }
  }

  @Override
  public void executionStarted(TestIdentifier testIdentifier) {
    RunReporter r = reporter;
    if (r == null) {
      return;
    }
    try {
      r.started(testIdentifier);
    } catch (RuntimeException e) {
      diagnostics.once("internal", "internal error while reporting an execution start", e);
    }
  }

  @Override
  public void executionFinished(TestIdentifier testIdentifier, TestExecutionResult result) {
    RunReporter r = reporter;
    if (r == null) {
      return;
    }
    try {
      r.finished(testIdentifier, result);
    } catch (RuntimeException e) {
      diagnostics.once("internal", "internal error while reporting an execution result", e);
    }
  }

  @Override
  public void reportingEntryPublished(TestIdentifier testIdentifier, ReportEntry entry) {
    RunReporter r = reporter;
    if (r == null) {
      return;
    }
    try {
      r.reportingEntry(testIdentifier, entry);
    } catch (RuntimeException e) {
      diagnostics.once("internal", "internal error while reporting a report entry", e);
    }
  }

  private synchronized void finishQuietly() {
    RunReporter r = reporter;
    reporter = null;
    if (r == null) {
      return;
    }
    try {
      r.finish();
    } catch (RuntimeException e) {
      diagnostics.once("internal", "internal error while finishing the session", e);
    }
  }
}
