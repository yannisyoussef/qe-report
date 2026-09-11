package io.github.yannisyoussef.qe.report.protocol;

import org.jspecify.annotations.Nullable;

/** How much an adapter trusts a historical identity to survive unrelated edits. */
public enum HistoricalIdStability {
  STABLE("stable"),
  /** Derived from positional information such as indexes or line numbers. */
  UNCERTAIN("uncertain"),
  /** No historical identity can be given, for example a dynamically generated test. */
  UNAVAILABLE("unavailable");

  private final String wireName;

  HistoricalIdStability(String wireName) {
    this.wireName = wireName;
  }

  public String wireName() {
    return wireName;
  }

  public static @Nullable HistoricalIdStability fromWireName(String value) {
    for (HistoricalIdStability s : values()) {
      if (s.wireName.equals(value)) {
        return s;
      }
    }
    return null;
  }
}
