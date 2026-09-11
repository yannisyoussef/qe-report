package io.github.yannisyoussef.qe.report.protocol;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/** Insertion-ordered, unmodifiable copies. Map.copyOf would randomise iteration order. */
final class Maps {
  private Maps() {}

  static Map<String, String> copy(Map<String, String> source) {
    if (source.isEmpty()) {
      return Map.of();
    }
    return Collections.unmodifiableMap(new LinkedHashMap<>(source));
  }
}
