package io.github.yannisyoussef.qe.report.protocol;

import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * Why an attempt or step failed.
 *
 * @param type runner-native classification, for example an exception class name
 * @param phase where it originated when the runner can tell
 */
public record Failure(
    String message,
    @Nullable String type,
    @Nullable String stackTrace,
    @Nullable FailurePhase phase,
    @Nullable Location location) {

  public Failure {
    Objects.requireNonNull(message, "message");
  }

  /** A failure carrying only a message. */
  public static Failure of(String message) {
    return new Failure(message, null, null, null, null);
  }
}
