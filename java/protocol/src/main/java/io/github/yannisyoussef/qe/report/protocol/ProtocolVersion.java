package io.github.yannisyoussef.qe.report.protocol;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The protocol version this binding writes and the range it reads.
 *
 * <p>Before 1.0 the compatibility unit is {@code 0.minor}: a consumer of line 0.3 reads any 0.3.x
 * event and rejects every other version. From 1.0 the unit becomes the major.
 */
public final class ProtocolVersion {
  /** The version written by this binding. */
  public static final String CURRENT = "0.3.0";

  private static final int SUPPORTED_MAJOR = 0;
  private static final int SUPPORTED_MINOR = 3;
  private static final Pattern SEMVER =
      Pattern.compile("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$");

  private ProtocolVersion() {}

  /** A parsed Semantic Version without prerelease or build parts. */
  public record Parsed(int major, int minor, int patch) {}

  /**
   * Parses a Semantic Version.
   *
   * @throws IllegalArgumentException if the value is not {@code major.minor.patch}
   */
  public static Parsed parse(String version) {
    Matcher m = SEMVER.matcher(version);
    if (!m.matches()) {
      throw new IllegalArgumentException("not a semantic version: " + version);
    }
    return new Parsed(
        Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)));
  }

  /** Whether an event carrying this version can be read by this binding. */
  public static boolean isSupported(String version) {
    try {
      return isSupported(parse(version));
    } catch (IllegalArgumentException e) {
      return false;
    }
  }

  /** Whether an event carrying this version can be read by this binding. */
  public static boolean isSupported(Parsed version) {
    return version.major() == SUPPORTED_MAJOR && version.minor() == SUPPORTED_MINOR;
  }
}
