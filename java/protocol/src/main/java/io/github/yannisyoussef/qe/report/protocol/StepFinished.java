package io.github.yannisyoussef.qe.report.protocol;

import java.util.List;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/** A step ended. */
public record StepFinished(
    String stepId,
    String attemptId,
    Status status,
    @Nullable String rawStatus,
    @Nullable Long durationMs,
    List<Failure> failures)
    implements Payload {

  public StepFinished {
    Objects.requireNonNull(stepId, "stepId");
    Objects.requireNonNull(attemptId, "attemptId");
    Objects.requireNonNull(status, "status");
    failures = List.copyOf(failures);
  }

  @Override
  public String eventType() {
    return EventTypes.STEP_FINISHED;
  }
}
