package io.github.yannisyoussef.qe.report.protocol;

import java.util.List;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * A failure at a non-test scope of the runner hierarchy (a class, suite, file, module, or analogous
 * node). It contributes to the execution's failed outcome without changing any child attempt's
 * verdict. Session-scoped: valid between {@code session.started} and {@code session.finished},
 * before or after the child attempts.
 *
 * @param path the failing scope itself, outermost first, in the same segments a test path uses
 * @param failures why it failed; never empty
 */
public record ScopeFailed(
    List<PathSegment> path,
    @Nullable String displayName,
    @Nullable String rawStatus,
    @Nullable Location location,
    List<Failure> failures)
    implements Payload {

  public ScopeFailed {
    path = List.copyOf(path);
    failures = List.copyOf(failures);
    if (path.isEmpty()) {
      throw new IllegalArgumentException("path must identify the failing scope");
    }
    if (failures.isEmpty()) {
      throw new IllegalArgumentException("a scope failure carries at least one failure");
    }
  }

  /** A scope failure with only the required fields. */
  public static ScopeFailed of(List<PathSegment> path, Failure failure) {
    return new ScopeFailed(
        path, null, null, null, List.of(Objects.requireNonNull(failure, "failure")));
  }

  @Override
  public String eventType() {
    return EventTypes.SCOPE_FAILED;
  }
}
