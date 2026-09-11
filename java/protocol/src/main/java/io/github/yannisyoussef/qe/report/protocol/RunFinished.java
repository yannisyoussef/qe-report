package io.github.yannisyoussef.qe.report.protocol;

/**
 * Every session of the run has finished. Emitted only by a producer that knows this; nothing for
 * the run is valid after it.
 */
public record RunFinished() implements Payload {
  @Override
  public String eventType() {
    return EventTypes.RUN_FINISHED;
  }
}
