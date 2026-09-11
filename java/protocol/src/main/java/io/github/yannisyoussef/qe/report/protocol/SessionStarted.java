package io.github.yannisyoussef.qe.report.protocol;

import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/** A producer process began contributing to the run. */
public record SessionStarted(
    Component producer,
    @Nullable Component runner,
    Map<String, String> environment,
    @Nullable Executor executor,
    @Nullable Source source,
    Map<String, String> labels)
    implements Payload {

  public SessionStarted {
    Objects.requireNonNull(producer, "producer");
    environment = Maps.copy(environment);
    labels = Maps.copy(labels);
  }

  /** Session start with only the required producer. */
  public static SessionStarted of(Component producer) {
    return new SessionStarted(producer, null, Map.of(), null, null, Map.of());
  }

  @Override
  public String eventType() {
    return EventTypes.SESSION_STARTED;
  }
}
