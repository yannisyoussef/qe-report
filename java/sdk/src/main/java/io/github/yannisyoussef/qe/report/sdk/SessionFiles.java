package io.github.yannisyoussef.qe.report.sdk;

/** Naming contract for session event files inside a run directory. */
public final class SessionFiles {
  private SessionFiles() {}

  /**
   * The event file name for a session: the sessionId reduced to {@code [A-Za-z0-9._-]} (a leading
   * character that is not a letter, digit, or underscore becomes one), at most 48 characters, plus
   * the first 12 hex digits of its SHA-256. The suffix keeps names unique when sanitisation
   * collides; the sanitiser removes anything a path could use. The TypeScript SDK and the fixture
   * generator apply the same contract. The events inside the file, not the name, carry the
   * authoritative sessionId.
   */
  public static String fileName(String sessionId) {
    return SafeNames.stem(sessionId) + "-" + SafeNames.hash(sessionId) + ".ndjson";
  }
}
