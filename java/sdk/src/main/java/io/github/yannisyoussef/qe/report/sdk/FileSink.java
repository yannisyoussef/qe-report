package io.github.yannisyoussef.qe.report.sdk;

import io.github.yannisyoussef.qe.report.protocol.Event;
import io.github.yannisyoussef.qe.report.protocol.ProtocolJson;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * Writes one session of a run to a run directory:
 *
 * <pre>
 * &lt;run&gt;/events/&lt;session file&gt;.ndjson   this session's events, created exclusively
 * &lt;run&gt;/attachments/&lt;sha256&gt;           bytes shared by every session of the run
 * </pre>
 *
 * <p>Several processes may write to the same run directory at once: each owns its event file, and
 * attachment bytes are written to a uniquely named temporary file, hashed, and published under the
 * hash by an atomic move. Two writers publishing the same bytes both succeed. Every event is
 * flushed as it is written, so a partial file is inspectable after a crash.
 */
public final class FileSink implements ReportSink {
  /** Default per-attachment limit: 64 MiB. */
  public static final long DEFAULT_MAX_ATTACHMENT_BYTES = 64L * 1024 * 1024;

  public static final String EVENTS_DIR = "events";
  public static final String ATTACHMENTS_DIR = "attachments";

  private final Path eventFile;
  private final Path attachmentsDir;
  private final BufferedWriter events;
  private final long maxAttachmentBytes;
  private boolean closed;

  private FileSink(
      Path eventFile, Path attachmentsDir, BufferedWriter events, long maxAttachmentBytes) {
    this.eventFile = eventFile;
    this.attachmentsDir = attachmentsDir;
    this.events = events;
    this.maxAttachmentBytes = maxAttachmentBytes;
  }

  /** Opens the sink for one session with the default attachment limit. */
  public static FileSink open(Path runDirectory, String sessionId) throws IOException {
    return open(runDirectory, sessionId, DEFAULT_MAX_ATTACHMENT_BYTES);
  }

  /**
   * Opens the sink for one session. The event file is created exclusively and must not exist: a
   * second process using the same sessionId is a producer error, reported here rather than silently
   * interleaved. A restarted producer uses a new sessionId.
   */
  public static FileSink open(Path runDirectory, String sessionId, long maxAttachmentBytes)
      throws IOException {
    if (maxAttachmentBytes < 0) {
      throw new IllegalArgumentException("maxAttachmentBytes must be >= 0");
    }
    Path eventsDir = runDirectory.resolve(EVENTS_DIR);
    Path attachments = runDirectory.resolve(ATTACHMENTS_DIR);
    Files.createDirectories(eventsDir);
    Files.createDirectories(attachments);
    Path eventFile = eventsDir.resolve(SessionFiles.fileName(sessionId));
    BufferedWriter writer =
        Files.newBufferedWriter(
            eventFile,
            StandardCharsets.UTF_8,
            StandardOpenOption.CREATE_NEW,
            StandardOpenOption.WRITE);
    return new FileSink(eventFile, attachments, writer, maxAttachmentBytes);
  }

  /** This session's event file. */
  public Path eventFile() {
    return eventFile;
  }

  @Override
  public long maxAttachmentBytes() {
    return maxAttachmentBytes;
  }

  @Override
  public synchronized void write(Event event) throws IOException {
    ensureOpen();
    events.write(ProtocolJson.write(event));
    events.write('\n');
    events.flush();
  }

  @Override
  public StoredAttachment storeAttachment(InputStream bytes) throws IOException {
    ensureOpen();
    // A name no other process or sink can produce; created atomically by the filesystem.
    Path temp = Files.createTempFile(attachmentsDir, ".tmp-", "");
    MessageDigest digest = sha256();
    long size = 0;
    try {
      try (OutputStream out = Files.newOutputStream(temp)) {
        byte[] buffer = new byte[8192];
        int n;
        while ((n = bytes.read(buffer)) > 0) {
          size += n;
          if (size > maxAttachmentBytes) {
            throw new AttachmentTooLargeException(maxAttachmentBytes);
          }
          digest.update(buffer, 0, n);
          out.write(buffer, 0, n);
        }
      }
      String hex = HexFormat.of().formatHex(digest.digest());
      publish(temp, attachmentsDir.resolve(hex), size);
      return new StoredAttachment(hex, size);
    } finally {
      Files.deleteIfExists(temp);
    }
  }

  /**
   * Publishes a fully written temporary file under its hash. An atomic move replaces an existing
   * target on POSIX, so concurrent identical publications both succeed. Where the filesystem
   * refuses to replace an existing target, the existing file is accepted when its size matches: it
   * can only have been published by this same procedure from bytes with the same hash.
   */
  private static void publish(Path temp, Path target, long size) throws IOException {
    try {
      Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE);
    } catch (IOException e) {
      if (Files.exists(target) && Files.size(target) == size) {
        return;
      }
      throw e;
    }
  }

  @Override
  public synchronized void close() throws IOException {
    if (!closed) {
      closed = true;
      events.close();
    }
  }

  private synchronized void ensureOpen() throws IOException {
    if (closed) {
      throw new IOException("sink is closed");
    }
  }

  static MessageDigest sha256() {
    try {
      return MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 is required by the JVM specification", e);
    }
  }
}
