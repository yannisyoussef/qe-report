package io.github.yannisyoussef.qe.report.protocol;

import java.util.Objects;

/**
 * One container in the runner's hierarchy. Well-known kinds are {@code file} and {@code group};
 * other kinds are permitted and treated like a group by consumers that do not know them.
 */
public record PathSegment(String kind, String name) {
  public static final String FILE = "file";
  public static final String GROUP = "group";

  public PathSegment {
    Objects.requireNonNull(kind, "kind");
    Objects.requireNonNull(name, "name");
  }
}
