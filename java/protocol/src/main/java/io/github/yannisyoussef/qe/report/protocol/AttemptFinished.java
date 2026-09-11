package io.github.yannisyoussef.qe.report.protocol;

import java.util.List;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * The attempt ended.
 *
 * @param expectedStatus what the author declared; null means passed
 * @param durationMs runner-reported duration when available
 * @param failures empty when there is nothing to report
 */
public record AttemptFinished(
    String attemptId,
    Status status,
    @Nullable String rawStatus,
    @Nullable ExpectedStatus expectedStatus,
    @Nullable Long durationMs,
    List<Failure> failures)
    implements Payload {

  public AttemptFinished {
    Objects.requireNonNull(attemptId, "attemptId");
    Objects.requireNonNull(status, "status");
    failures = List.copyOf(failures);
  }

  /** A finished attempt with only the required fields. */
  public static AttemptFinished of(String attemptId, Status status) {
    return new AttemptFinished(attemptId, status, null, null, null, List.of());
  }

  @Override
  public String eventType() {
    return EventTypes.ATTEMPT_FINISHED;
  }
}
