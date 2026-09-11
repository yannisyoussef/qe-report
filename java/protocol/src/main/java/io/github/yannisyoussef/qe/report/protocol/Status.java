package io.github.yannisyoussef.qe.report.protocol;

import org.jspecify.annotations.Nullable;

/** Canonical attempt or step status. */
public enum Status {
  PASSED("passed"),
  FAILED("failed"),
  /** The body did not run to a verdict by decision: disabled, assumption, runtime skip. */
  SKIPPED("skipped"),
  /** Execution ended without a verdict for reasons outside the test: interrupted, cancelled. */
  INCONCLUSIVE("inconclusive");

  private final String wireName;

  Status(String wireName) {
    this.wireName = wireName;
  }

  /** The value written to JSON. */
  public String wireName() {
    return wireName;
  }

  /** The status for a JSON value, or null if unknown. */
  public static @Nullable Status fromWireName(String value) {
    for (Status s : values()) {
      if (s.wireName.equals(value)) {
        return s;
      }
    }
    return null;
  }
}
