package io.github.yannisyoussef.qe.report.sdk;

import io.github.yannisyoussef.qe.report.protocol.AttachmentAdded;
import io.github.yannisyoussef.qe.report.protocol.Event;
import io.github.yannisyoussef.qe.report.protocol.Payload;
import io.github.yannisyoussef.qe.report.protocol.ProtocolJson;
import io.github.yannisyoussef.qe.report.protocol.ProtocolVersion;
import io.github.yannisyoussef.qe.report.protocol.RunFinished;
import io.github.yannisyoussef.qe.report.protocol.SessionFinished;
import io.github.yannisyoussef.qe.report.protocol.SessionStarted;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;
import org.jspecify.annotations.Nullable;

/**
 * Writes the events of one session: fills the envelope (protocol version, event id, sequence,
 * timestamp), redacts, enforces the event size limit, and hands the result to a sink.
 *
 * <p>Thread-safe: adapters observing parallel tests may emit from several threads. Nothing thrown
 * by the sink escapes; problems go to the handler.
 */
public final class ReportSession implements AutoCloseable {
  /** Maximum serialised event size in UTF-8 bytes, including the newline. */
  public static final int MAX_EVENT_BYTES = 1_048_576;

  private static final DateTimeFormatter TIMESTAMP =
      DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSSXXX");

  private final String runId;
  private final String sessionId;
  private final ReportSink sink;
  private final Clock clock;
  private final Supplier<String> ids;
  private final Redactor redactor;
  private final ReportProblemHandler problems;
  private final int maxEventBytes;
  private long sequence;
  private long written;
  private long dropped;
  private boolean finished;
  private boolean closed;

  private ReportSession(Builder b) {
    this.runId = b.runId;
    this.sessionId = b.sessionId;
    this.sink = b.sink;
    this.clock = b.clock;
    this.ids = b.ids;
    this.redactor = b.redactor;
    this.problems = b.problems;
    this.maxEventBytes = b.maxEventBytes;
  }

  /** Starts building a session. {@link Builder#start} emits {@code session.started}. */
  public static Builder builder(String runId, String sessionId, ReportSink sink) {
    return new Builder(runId, sessionId, sink);
  }

  public String runId() {
    return runId;
  }

  public String sessionId() {
    return sessionId;
  }

  /** Emits one event. Returns false if it was dropped; the handler has been told why. */
  public synchronized boolean emit(Payload payload) {
    if (finished) {
      problems.onProblem(
          new ReportProblem(
              ReportProblem.Kind.SESSION_FINISHED,
              "event " + payload.eventType() + " emitted after session.finished; dropped",
              null));
      dropped++;
      return false;
    }
    Event candidate =
        new Event(
            ProtocolVersion.CURRENT,
            ids.get(),
            payload.eventType(),
            runId,
            sessionId,
            sequence + 1,
            TIMESTAMP.format(clock.instant().atOffset(ZoneOffset.UTC)),
            null,
            payload);
    Event event = redactor.redactEvent(candidate);
    int bytes = ProtocolJson.write(event).getBytes(StandardCharsets.UTF_8).length + 1;
    if (bytes > maxEventBytes) {
      problems.onProblem(
          new ReportProblem(
              ReportProblem.Kind.EVENT_TOO_LARGE,
              "event "
                  + payload.eventType()
                  + " is "
                  + bytes
                  + " bytes, limit "
                  + maxEventBytes
                  + "; dropped",
              null));
      dropped++;
      return false;
    }
    try {
      sink.write(event);
    } catch (IOException | RuntimeException e) {
      problems.onProblem(
          new ReportProblem(
              ReportProblem.Kind.SINK_FAILURE, "cannot write " + payload.eventType(), e));
      dropped++;
      return false;
    }
    sequence++;
    written++;
    if (payload instanceof SessionFinished) {
      finished = true;
    }
    return true;
  }

  /** Stores bytes as an attachment and emits {@code attachment.added}. Text is redacted first. */
  public boolean attach(
      String attemptId, @Nullable String stepId, String name, String mediaType, byte[] bytes) {
    byte[] content = bytes;
    if (MediaTypes.isTextual(mediaType)) {
      content =
          redactor
              .redactText(new String(bytes, StandardCharsets.UTF_8))
              .getBytes(StandardCharsets.UTF_8);
    }
    return store(attemptId, stepId, name, mediaType, new ByteArrayInputStream(content));
  }

  /**
   * Stores a file as an attachment and emits {@code attachment.added}. Binary content is streamed;
   * text is read fully so it can be redacted.
   */
  public boolean attach(
      String attemptId, @Nullable String stepId, String name, String mediaType, Path file) {
    try {
      if (MediaTypes.isTextual(mediaType)) {
        return attach(attemptId, stepId, name, mediaType, Files.readAllBytes(file));
      }
      try (InputStream in = Files.newInputStream(file)) {
        return store(attemptId, stepId, name, mediaType, in);
      }
    } catch (IOException e) {
      problems.onProblem(
          new ReportProblem(ReportProblem.Kind.SINK_FAILURE, "cannot read attachment " + name, e));
      return false;
    }
  }

  private boolean store(
      String attemptId, @Nullable String stepId, String name, String mediaType, InputStream in) {
    ReportSink.StoredAttachment stored;
    try {
      stored = sink.storeAttachment(in);
    } catch (ReportSink.AttachmentTooLargeException e) {
      problems.onProblem(
          new ReportProblem(ReportProblem.Kind.ATTACHMENT_TOO_LARGE, "attachment " + name, e));
      return false;
    } catch (IOException | RuntimeException e) {
      problems.onProblem(
          new ReportProblem(ReportProblem.Kind.SINK_FAILURE, "cannot store attachment " + name, e));
      return false;
    }
    return emit(
        new AttachmentAdded(
            attemptId, stepId, name, mediaType, stored.sizeBytes(), stored.sha256()));
  }

  /** Emits {@code session.finished}. Further events are dropped and reported. */
  public boolean finish() {
    return emit(new SessionFinished());
  }

  /**
   * Emits {@code run.finished}. Only for a producer that knows every session of the run has
   * finished; the session itself is finished first if it is not already.
   */
  public synchronized boolean finishRun() {
    if (!finished) {
      finish();
    }
    finished = false;
    boolean ok = emit(new RunFinished());
    finished = true;
    return ok;
  }

  /** Finishes the session if needed and closes the sink. */
  @Override
  public synchronized void close() {
    if (closed) {
      return;
    }
    closed = true;
    if (!finished) {
      finish();
    }
    try {
      sink.close();
    } catch (IOException | RuntimeException e) {
      problems.onProblem(
          new ReportProblem(ReportProblem.Kind.SINK_FAILURE, "cannot close sink", e));
    }
  }

  /** Counts so far. */
  public synchronized Summary summary() {
    return new Summary(written, dropped);
  }

  public record Summary(long eventsWritten, long eventsDropped) {}

  /** Configuration for a session. */
  public static final class Builder {
    private final String runId;
    private final String sessionId;
    private final ReportSink sink;
    private Clock clock = Clock.systemUTC();
    private Supplier<String> ids = () -> UUID.randomUUID().toString();
    private Redactor redactor = Redactor.defaults();
    private ReportProblemHandler problems = ReportProblemHandler.standardError();
    private int maxEventBytes = MAX_EVENT_BYTES;

    private Builder(String runId, String sessionId, ReportSink sink) {
      this.runId = Objects.requireNonNull(runId, "runId");
      this.sessionId = Objects.requireNonNull(sessionId, "sessionId");
      this.sink = Objects.requireNonNull(sink, "sink");
    }

    /** The clock for {@code occurredAt}. Inject a fixed clock for deterministic output. */
    public Builder clock(Clock clock) {
      this.clock = Objects.requireNonNull(clock, "clock");
      return this;
    }

    /** Generates event ids. Inject a counter for deterministic output. */
    public Builder ids(Supplier<String> ids) {
      this.ids = Objects.requireNonNull(ids, "ids");
      return this;
    }

    public Builder redactor(Redactor redactor) {
      this.redactor = Objects.requireNonNull(redactor, "redactor");
      return this;
    }

    public Builder problems(ReportProblemHandler handler) {
      this.problems = Objects.requireNonNull(handler, "handler");
      return this;
    }

    /** Lowers the event size limit. It cannot be raised above the protocol limit. */
    public Builder maxEventBytes(int maxEventBytes) {
      if (maxEventBytes < 1 || maxEventBytes > MAX_EVENT_BYTES) {
        throw new IllegalArgumentException("maxEventBytes must be within 1.." + MAX_EVENT_BYTES);
      }
      this.maxEventBytes = maxEventBytes;
      return this;
    }

    /** Creates the session and emits {@code session.started}. */
    public ReportSession start(SessionStarted payload) {
      ReportSession session = new ReportSession(this);
      session.emit(payload);
      return session;
    }
  }
}
