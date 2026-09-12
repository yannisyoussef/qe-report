package io.github.yannisyoussef.qe.report.protocol;

import java.util.List;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * The producer process finished; it will emit no further session-scoped event. The payload may
 * carry the runner's aggregate outcome for the completed session: its canonical {@code status}, the
 * runner's own word in {@code rawStatus}, and {@code failures} that belong to the invocation as a
 * whole rather than to any attempt or scope (a global setup or teardown exception). A producer
 * whose runner exposes no such outcome emits {@link #empty()}.
 *
 * @param status the aggregate outcome, or null when the runner exposes none
 * @param rawStatus the runner's own aggregate word; requires a status
 * @param failures errors of the invocation itself; require a status and never accompany passed
 */
public record SessionFinished(
    @Nullable SessionStatus status, @Nullable String rawStatus, List<Failure> failures)
    implements Payload {

  public SessionFinished {
    failures = List.copyOf(failures);
    if (status == null && rawStatus != null) {
      throw new IllegalArgumentException("rawStatus requires a status");
    }
    if (status == null && !failures.isEmpty()) {
      throw new IllegalArgumentException("session failures require a status");
    }
    if (status == SessionStatus.PASSED && !failures.isEmpty()) {
      throw new IllegalArgumentException("a passed session carries no failures");
    }
  }

  /** No aggregate outcome: the runner exposes none, consumers derive it from the facts. */
  public SessionFinished() {
    this(null, null, List.of());
  }

  /** The same as {@link #SessionFinished()}, for call sites that read better with a name. */
  public static SessionFinished empty() {
    return new SessionFinished();
  }

  /** An outcome with only the canonical status. */
  public static SessionFinished of(SessionStatus status) {
    return new SessionFinished(Objects.requireNonNull(status, "status"), null, List.of());
  }

  @Override
  public String eventType() {
    return EventTypes.SESSION_FINISHED;
  }
}
