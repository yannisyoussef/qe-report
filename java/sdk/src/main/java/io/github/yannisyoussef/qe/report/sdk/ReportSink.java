package io.github.yannisyoussef.qe.report.sdk;

import io.github.yannisyoussef.qe.report.protocol.Event;
import java.io.IOException;
import java.io.InputStream;

/** Where a session writes events and attachment bytes. */
public interface ReportSink extends AutoCloseable {

  /** Writes one event. The event is already redacted and within the size limit. */
  void write(Event event) throws IOException;

  /**
   * Stores attachment bytes and returns their digest and size. The bytes are read once; the caller
   * decides what to do with the result.
   *
   * @throws AttachmentTooLargeException if the stream exceeds the sink's limit
   */
  StoredAttachment storeAttachment(InputStream bytes) throws IOException;

  @Override
  void close() throws IOException;

  /** Digest and size of stored bytes. */
  record StoredAttachment(String sha256, long sizeBytes) {}

  /** Thrown by {@link #storeAttachment} when the limit is exceeded; nothing was stored. */
  final class AttachmentTooLargeException extends IOException {
    private static final long serialVersionUID = 1L;

    public AttachmentTooLargeException(long limit) {
      super("attachment exceeds " + limit + " bytes");
    }
  }
}
