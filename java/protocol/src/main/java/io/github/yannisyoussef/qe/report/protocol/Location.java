package io.github.yannisyoussef.qe.report.protocol;

import java.util.Objects;
import org.jspecify.annotations.Nullable;

/** Where a test or step is defined. Display only; never resolved on a server. */
public record Location(String file, @Nullable Long line, @Nullable Long column) {
  public Location {
    Objects.requireNonNull(file, "file");
  }
}
