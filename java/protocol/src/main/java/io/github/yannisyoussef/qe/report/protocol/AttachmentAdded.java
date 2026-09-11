package io.github.yannisyoussef.qe.report.protocol;

import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * Metadata for bytes stored outside the event stream. Must precede the {@code attempt.finished} of
 * its attempt.
 *
 * @param name display name chosen by the producer; never used to locate the bytes
 * @param sha256 lower-case hex digest of the stored bytes
 */
public record AttachmentAdded(
    String attemptId,
    @Nullable String stepId,
    String name,
    String mediaType,
    long sizeBytes,
    String sha256)
    implements Payload {

  public AttachmentAdded {
    Objects.requireNonNull(attemptId, "attemptId");
    Objects.requireNonNull(name, "name");
    Objects.requireNonNull(mediaType, "mediaType");
    Objects.requireNonNull(sha256, "sha256");
  }

  @Override
  public String eventType() {
    return EventTypes.ATTACHMENT_ADDED;
  }
}
