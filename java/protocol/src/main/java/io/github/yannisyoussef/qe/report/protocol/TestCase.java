package io.github.yannisyoussef.qe.report.protocol;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * The test an attempt executes.
 *
 * @param executionId identifies the logical test within the run; shared by all its attempts
 * @param historicalId identifies the same logical test across runs; null only when {@code
 *     historicalIdStability} is {@link HistoricalIdStability#UNAVAILABLE}
 * @param path containers in the runner's own hierarchy, outermost first
 * @param location where the test is defined, for display only
 */
public record TestCase(
    String executionId,
    @Nullable String historicalId,
    HistoricalIdStability historicalIdStability,
    String displayName,
    List<PathSegment> path,
    @Nullable Location location,
    List<String> tags,
    Map<String, String> labels) {

  public TestCase {
    Objects.requireNonNull(executionId, "executionId");
    Objects.requireNonNull(historicalIdStability, "historicalIdStability");
    Objects.requireNonNull(displayName, "displayName");
    path = List.copyOf(path);
    tags = List.copyOf(tags);
    labels = Maps.copy(labels);
    boolean unavailable = historicalIdStability == HistoricalIdStability.UNAVAILABLE;
    if (unavailable && historicalId != null) {
      throw new IllegalArgumentException(
          "historicalId must be absent when stability is unavailable");
    }
    if (!unavailable && historicalId == null) {
      throw new IllegalArgumentException(
          "historicalId is required unless stability is unavailable");
    }
  }
}
