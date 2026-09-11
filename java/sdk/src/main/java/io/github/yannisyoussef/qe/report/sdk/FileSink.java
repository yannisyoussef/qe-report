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
import java.util.concurrent.atomic.AtomicLong;

/**
 * Writes a run to a directory: {@code events.ndjson} plus {@code attachments/<sha256>}.
 *
 * <p>Every event is flushed as it is written, so a partial file is inspectable after a crash.
 * Attachment bytes are streamed to a temporary file while hashed, then moved to their final name
 * atomically; the producer's display name never influences the path. Nothing is buffered beyond one
 * event.
 */
public final class FileSink implements ReportSink {
  /** Default per-attachment limit: 64 MiB. */
  public static final long DEFAULT_MAX_ATTACHMENT_BYTES = 64L * 1024 * 1024;

  public static final String EVENTS_FILE = "events.ndjson";
  public static final String ATTACHMENTS_DIR = "attachments";

  private final Path attachmentsDir;
  private final BufferedWriter events;
  private final long maxAttachmentBytes;
  private final AtomicLong tempCounter = new AtomicLong();
  private boolean closed;

  private FileSink(Path attachmentsDir, BufferedWriter events, long maxAttachmentBytes) {
    this.attachmentsDir = attachmentsDir;
    this.events = events;
    this.maxAttachmentBytes = maxAttachmentBytes;
  }

  /** Opens (creating if needed) a run directory with the default attachment limit. */
  public static FileSink open(Path directory) throws IOException {
    return open(directory, DEFAULT_MAX_ATTACHMENT_BYTES);
  }

  /** Opens (creating if needed) a run directory. Events are appended if the file exists. */
  public static FileSink open(Path directory, long maxAttachmentBytes) throws IOException {
    if (maxAttachmentBytes < 0) {
      throw new IllegalArgumentException("maxAttachmentBytes must be >= 0");
    }
    Path attachments = directory.resolve(ATTACHMENTS_DIR);
    Files.createDirectories(attachments);
    BufferedWriter writer =
        Files.newBufferedWriter(
            directory.resolve(EVENTS_FILE),
            StandardCharsets.UTF_8,
            StandardOpenOption.CREATE,
            StandardOpenOption.WRITE,
            StandardOpenOption.APPEND);
    return new FileSink(attachments, writer, maxAttachmentBytes);
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
    Path temp = attachmentsDir.resolve(".tmp-" + tempCounter.incrementAndGet());
    MessageDigest digest = sha256();
    long size = 0;
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
    } catch (IOException e) {
      Files.deleteIfExists(temp);
      throw e;
    }
    String hex = HexFormat.of().formatHex(digest.digest());
    Path target = attachmentsDir.resolve(hex);
    if (Files.exists(target)) {
      Files.deleteIfExists(temp);
    } else {
      Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE);
    }
    return new StoredAttachment(hex, size);
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
