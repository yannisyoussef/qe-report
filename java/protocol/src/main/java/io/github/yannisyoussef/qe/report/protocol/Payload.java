package io.github.yannisyoussef.qe.report.protocol;

/** The typed content of an event. One record per event type, plus {@link UnknownPayload}. */
public sealed interface Payload
    permits SessionStarted,
        SessionFinished,
        RunFinished,
        AttemptStarted,
        AttemptFinished,
        StepStarted,
        StepFinished,
        AttachmentAdded,
        UnknownPayload {

  /** The event type this payload belongs to. */
  String eventType();
}
