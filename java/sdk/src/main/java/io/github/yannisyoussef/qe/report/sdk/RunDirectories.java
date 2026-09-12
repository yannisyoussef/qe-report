package io.github.yannisyoussef.qe.report.sdk;

import java.nio.file.Path;

/**
 * Naming contract for run directories under an output root:
 *
 * <pre>
 * {@code <output root>/runs/<run directory>/events/...}
 * {@code <output root>/runs/<run directory>/attachments/...}
 * </pre>
 *
 * <p>One physical run directory holds one logical run, so every process reporting into the same run
 * resolves the same directory from the same {@code runId}, and two runs never share one. The
 * directory is a locator only: the {@code runId} inside the events stays authoritative and is never
 * read back from the name.
 */
public final class RunDirectories {
  /** The collection of run directories under an output root. */
  public static final String RUNS_DIR = "runs";

  private RunDirectories() {}

  /**
   * The directory name for a run: the runId reduced to {@code [A-Za-z0-9._-]}, a leading character
   * that is not a letter, digit, or underscore replaced by one, cut to 48 characters, a reserved
   * device basename such as {@code CON} or {@code NUL.txt} then neutralised the same way, and
   * {@code -} plus the first 12 hex digits of the SHA-256 of the original id appended. The same
   * contract as session file names, without the extension; the TypeScript SDK computes the same
   * name.
   */
  public static String directoryName(String runId) {
    return SafeNames.stem(runId) + "-" + SafeNames.hash(runId);
  }

  /**
   * The run directory for a run under an output root: {@code <outputRoot>/runs/<directoryName>}.
   * The name contains no separator, so the result is always exactly one component below {@code
   * runs}; that is checked after normalisation rather than assumed.
   */
  public static Path resolve(Path outputRoot, String runId) {
    Path runs = outputRoot.resolve(RUNS_DIR);
    Path dir = runs.resolve(directoryName(runId));
    Path normalisedRuns = runs.toAbsolutePath().normalize();
    Path normalised = dir.toAbsolutePath().normalize();
    if (!normalisedRuns.equals(normalised.getParent())) {
      throw new IllegalArgumentException("run directory escapes the output root: " + runId);
    }
    return dir;
  }
}
