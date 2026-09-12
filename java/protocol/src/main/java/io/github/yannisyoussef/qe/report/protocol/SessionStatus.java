package io.github.yannisyoussef.qe.report.protocol;

import org.jspecify.annotations.Nullable;

/**
 * Canonical aggregate outcome of one session as reported by the runner invocation itself. It is
 * distinct from the attempt and step status: a session is never skipped and has no expected status.
 * A runner that exposes no such outcome reports none, and consumers derive the run verdict from
 * attempt and scope facts alone.
 */
public enum SessionStatus {
  /** The invocation completed with a successful aggregate outcome. */
  PASSED("passed"),
  /**
   * The invocation completed with a failed aggregate outcome, whether or not a test or a hierarchy
   * scope explains it (a runner policy, a global hook, a global timeout).
   */
  FAILED("failed"),
  /** The invocation completed without a pass or fail verdict: interrupted, cancelled. */
  INCONCLUSIVE("inconclusive");

  private final String wireName;

  SessionStatus(String wireName) {
    this.wireName = wireName;
  }

  /** The value written to JSON. */
  public String wireName() {
    return wireName;
  }

  /** The status for a JSON value, or null if unknown. */
  public static @Nullable SessionStatus fromWireName(String value) {
    for (SessionStatus s : values()) {
      if (s.wireName.equals(value)) {
        return s;
      }
    }
    return null;
  }
}
