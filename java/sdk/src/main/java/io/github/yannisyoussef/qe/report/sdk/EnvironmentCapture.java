package io.github.yannisyoussef.qe.report.sdk;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Captures environment variables by explicit allowlist only. The whole environment is never
 * captured; every captured value is redacted.
 */
public final class EnvironmentCapture {
  private EnvironmentCapture() {}

  /** Captures the named variables from the process environment, in the order given. */
  public static Map<String, String> fromSystem(Collection<String> names, Redactor redactor) {
    return fromMap(System.getenv(), names, redactor);
  }

  /** Captures the named entries from any map, in the order given. Absent names are skipped. */
  public static Map<String, String> fromMap(
      Map<String, String> source, Collection<String> names, Redactor redactor) {
    Map<String, String> out = new LinkedHashMap<>();
    for (String name : names) {
      String value = source.get(name);
      if (value != null) {
        out.put(name, redactor.redactText(value));
      }
    }
    return out;
  }
}
