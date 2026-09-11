package io.github.yannisyoussef.qe.report.protocol;

import org.jspecify.annotations.Nullable;

/** Where a failure originated when the runner can tell. */
public enum FailurePhase {
  SETUP("setup"),
  TEST("test"),
  TEARDOWN("teardown");

  private final String wireName;

  FailurePhase(String wireName) {
    this.wireName = wireName;
  }

  public String wireName() {
    return wireName;
  }

  public static @Nullable FailurePhase fromWireName(String value) {
    for (FailurePhase p : values()) {
      if (p.wireName.equals(value)) {
        return p;
      }
    }
    return null;
  }
}
