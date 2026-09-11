package io.github.yannisyoussef.qe.report.protocol;

import org.jspecify.annotations.Nullable;

/** What the test author declared the attempt should end with. Absent means passed. */
public enum ExpectedStatus {
  PASSED("passed"),
  FAILED("failed"),
  SKIPPED("skipped");

  private final String wireName;

  ExpectedStatus(String wireName) {
    this.wireName = wireName;
  }

  public String wireName() {
    return wireName;
  }

  public static @Nullable ExpectedStatus fromWireName(String value) {
    for (ExpectedStatus s : values()) {
      if (s.wireName.equals(value)) {
        return s;
      }
    }
    return null;
  }
}
