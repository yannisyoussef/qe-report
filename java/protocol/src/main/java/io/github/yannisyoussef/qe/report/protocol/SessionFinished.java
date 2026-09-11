package io.github.yannisyoussef.qe.report.protocol;

/** The producer process finished; it will emit nothing further. */
public record SessionFinished() implements Payload {
  @Override
  public String eventType() {
    return EventTypes.SESSION_FINISHED;
  }
}
