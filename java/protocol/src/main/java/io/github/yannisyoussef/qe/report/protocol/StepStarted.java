package io.github.yannisyoussef.qe.report.protocol;

import java.util.Objects;
import org.jspecify.annotations.Nullable;

/** A named unit of work inside an attempt began. Nest with {@code parentStepId}. */
public record StepStarted(
    String stepId,
    String attemptId,
    @Nullable String parentStepId,
    String name,
    @Nullable String kind,
    @Nullable Location location)
    implements Payload {

  public StepStarted {
    Objects.requireNonNull(stepId, "stepId");
    Objects.requireNonNull(attemptId, "attemptId");
    Objects.requireNonNull(name, "name");
  }

  @Override
  public String eventType() {
    return EventTypes.STEP_STARTED;
  }
}
