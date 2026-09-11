package io.github.yannisyoussef.qe.report.junitplatform.internal;

import io.github.yannisyoussef.qe.report.sdk.ReportProblem;
import java.io.PrintStream;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.jspecify.annotations.Nullable;

/**
 * The adapter's only output besides the report: one line per distinct problem on the given stream,
 * never an exception into JUnit. Repeats of the same key are suppressed so that a broken sink does
 * not print once per test.
 */
public final class Diagnostics {
  private static final String PREFIX = "qe-report-junit-platform: ";
  private static final int MAX_DISTINCT = 50;

  private final PrintStream log;
  private final Set<String> seen = ConcurrentHashMap.newKeySet();

  public Diagnostics(PrintStream log) {
    this.log = log;
  }

  public void once(String key, String message) {
    once(key, message, null);
  }

  public void once(String key, String message, @Nullable Throwable cause) {
    if (seen.size() >= MAX_DISTINCT || !seen.add(key)) {
      return;
    }
    log.println(PREFIX + message + (cause == null ? "" : " (" + cause + ")"));
  }

  public void note(List<String> notes) {
    for (String n : notes) {
      once("note:" + n, n);
    }
  }

  /** Receives the SDK's reporting problems. */
  public void problem(ReportProblem problem) {
    once(
        problem.kind() + ":" + problem.message(),
        problem.kind() + ": " + problem.message(),
        problem.cause());
  }
}
