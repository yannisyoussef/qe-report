package io.github.yannisyoussef.qe.report.protocol;

import java.util.Objects;
import org.jspecify.annotations.Nullable;

/** Why a JSON text could not be read as an event. */
public final class ProtocolException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  /** Classification a consumer can act on. */
  public enum Reason {
    /** Not a JSON object at all. */
    MALFORMED_JSON,
    /** A JSON object, but missing or mistyped required content. */
    SCHEMA_INVALID,
    /** A protocol version outside the supported compatibility line. */
    UNSUPPORTED_PROTOCOL_VERSION,
    /** An event type this binding does not know and the producer did not mark ignorable. */
    UNSUPPORTED_EVENT_TYPE
  }

  private final Reason reason;
  private final @Nullable String pointer;

  public ProtocolException(Reason reason, String message, @Nullable String pointer) {
    super(message);
    this.reason = Objects.requireNonNull(reason, "reason");
    this.pointer = pointer;
  }

  public Reason reason() {
    return reason;
  }

  /** JSON pointer to the offending value, when known. */
  public @Nullable String pointer() {
    return pointer;
  }
}
