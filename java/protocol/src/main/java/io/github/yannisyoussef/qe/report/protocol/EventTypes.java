package io.github.yannisyoussef.qe.report.protocol;

import java.util.Set;

/** The event type names of compatibility line 0.2. */
public final class EventTypes {
  public static final String SESSION_STARTED = "session.started";
  public static final String SESSION_FINISHED = "session.finished";
  public static final String RUN_FINISHED = "run.finished";
  public static final String ATTEMPT_STARTED = "attempt.started";
  public static final String ATTEMPT_FINISHED = "attempt.finished";
  public static final String STEP_STARTED = "step.started";
  public static final String STEP_FINISHED = "step.finished";
  public static final String ATTACHMENT_ADDED = "attachment.added";
  public static final String SCOPE_FAILED = "scope.failed";

  private static final Set<String> KNOWN =
      Set.of(
          SESSION_STARTED,
          SESSION_FINISHED,
          RUN_FINISHED,
          ATTEMPT_STARTED,
          ATTEMPT_FINISHED,
          STEP_STARTED,
          STEP_FINISHED,
          ATTACHMENT_ADDED,
          SCOPE_FAILED);

  private EventTypes() {}

  /** Whether this binding understands the event type. */
  public static boolean isKnown(String eventType) {
    return KNOWN.contains(eventType);
  }

  /** All event types this binding understands. */
  public static Set<String> known() {
    return KNOWN;
  }
}
