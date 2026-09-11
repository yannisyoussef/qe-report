package io.github.yannisyoussef.qe.report.sdk;

import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.regex.Pattern;

/** Naming contract for session event files inside a run directory. */
public final class SessionFiles {
  private static final Pattern UNSAFE = Pattern.compile("[^A-Za-z0-9._-]");
  private static final int MAX_STEM = 48;

  private SessionFiles() {}

  /**
   * The event file name for a session: the sessionId reduced to {@code [A-Za-z0-9._-]}, at most 48
   * characters, plus the first 12 hex digits of its SHA-256. The suffix keeps names unique when
   * sanitisation collides; the sanitiser removes anything a path could use. The TypeScript SDK and
   * the fixture generator apply the same contract. The events inside the file, not the name, carry
   * the authoritative sessionId.
   */
  public static String fileName(String sessionId) {
    String safe = UNSAFE.matcher(sessionId).replaceAll("_");
    if (safe.startsWith(".")) {
      safe = "_" + safe.substring(1);
    }
    if (safe.length() > MAX_STEM) {
      safe = safe.substring(0, MAX_STEM);
    }
    String hash =
        HexFormat.of()
            .formatHex(FileSink.sha256().digest(sessionId.getBytes(StandardCharsets.UTF_8)))
            .substring(0, 12);
    return safe + "-" + hash + ".ndjson";
  }
}
