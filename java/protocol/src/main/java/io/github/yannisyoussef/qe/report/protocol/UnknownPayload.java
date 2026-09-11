package io.github.yannisyoussef.qe.report.protocol;

import java.util.Objects;

/**
 * Payload of an event whose type this binding does not know and which the producer marked
 * ignorable. The payload JSON is kept verbatim so a consumer can store or forward it.
 */
public record UnknownPayload(String eventType, String payloadJson) implements Payload {
  public UnknownPayload {
    Objects.requireNonNull(eventType, "eventType");
    Objects.requireNonNull(payloadJson, "payloadJson");
  }
}
