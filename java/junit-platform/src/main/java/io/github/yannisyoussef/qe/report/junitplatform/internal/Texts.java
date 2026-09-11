package io.github.yannisyoussef.qe.report.junitplatform.internal;

import java.io.PrintWriter;
import java.io.StringWriter;

/** Bounds free text to the protocol's limits with a visible marker; never truncates silently. */
final class Texts {
  /** Stack traces are bounded well below the schema limit; a longer trace is noise, not signal. */
  static final int MAX_STACK_TRACE = 64 * 1024;

  static final int MAX_MESSAGE = 65_536;
  static final int MAX_DISPLAY = 1024;
  static final int MAX_LABEL = 1024;
  static final int MAX_TAG = 128;
  static final int MAX_TYPE = 512;

  private Texts() {}

  static String bounded(String text, int max) {
    if (text.length() <= max) {
      return text;
    }
    // The marker takes room of its own, so the count it shows includes what it displaced.
    int keep = Math.max(0, max - (" [truncated " + text.length() + " characters]").length());
    return text.substring(0, keep) + " [truncated " + (text.length() - keep) + " characters]";
  }

  static String stackTrace(Throwable t) {
    StringWriter sw = new StringWriter();
    t.printStackTrace(new PrintWriter(sw));
    return bounded(sw.toString(), MAX_STACK_TRACE);
  }
}
