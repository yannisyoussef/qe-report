package io.github.yannisyoussef.qe.report.protocol;

import java.util.Objects;

/** One execution of a test case began. Retries are further attempts with a higher number. */
public record AttemptStarted(String attemptId, int attemptNumber, TestCase test)
    implements Payload {

  public AttemptStarted {
    Objects.requireNonNull(attemptId, "attemptId");
    Objects.requireNonNull(test, "test");
    if (attemptNumber < 1) {
      throw new IllegalArgumentException("attemptNumber must be >= 1");
    }
  }

  @Override
  public String eventType() {
    return EventTypes.ATTEMPT_STARTED;
  }
}
