package io.github.yannisyoussef.qe.report.protocol;

import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * One protocol event: the envelope fields plus a typed payload.
 *
 * @param protocolVersion full Semantic Version written by the producer
 * @param eventId unique within the run
 * @param eventType discriminator; equals {@link Payload#eventType()} of the payload
 * @param runId the run this event belongs to
 * @param sessionId the producer process that emitted it
 * @param sequence 1-based, contiguous position within the session
 * @param occurredAt ISO-8601 timestamp with offset, from the producer clock
 * @param ignorable whether an older consumer may skip an unknown event type; null means absent
 *     (false)
 * @param payload the typed content
 */
public record Event(
    String protocolVersion,
    String eventId,
    String eventType,
    String runId,
    String sessionId,
    long sequence,
    String occurredAt,
    @Nullable Boolean ignorable,
    Payload payload) {

  public Event {
    Objects.requireNonNull(protocolVersion, "protocolVersion");
    Objects.requireNonNull(eventId, "eventId");
    Objects.requireNonNull(eventType, "eventType");
    Objects.requireNonNull(runId, "runId");
    Objects.requireNonNull(sessionId, "sessionId");
    Objects.requireNonNull(occurredAt, "occurredAt");
    Objects.requireNonNull(payload, "payload");
    if (!eventType.equals(payload.eventType())) {
      throw new IllegalArgumentException(
          "eventType " + eventType + " does not match payload " + payload.eventType());
    }
    if (sequence < 1) {
      throw new IllegalArgumentException("sequence must be >= 1");
    }
  }

  /** Whether the event is marked ignorable by consumers that do not know its type. */
  public boolean isIgnorable() {
    return Boolean.TRUE.equals(ignorable);
  }
}
