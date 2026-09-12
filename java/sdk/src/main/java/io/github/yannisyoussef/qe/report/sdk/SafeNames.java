package io.github.yannisyoussef.qe.report.sdk;

import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.regex.Pattern;

/**
 * The one naming rule behind session files and run directories: a readable stem that no path can
 * use, plus a short digest that keeps colliding stems apart. The name is a locator only; the
 * identifier inside the events stays authoritative.
 */
final class SafeNames {
  private static final Pattern UNSAFE = Pattern.compile("[^A-Za-z0-9._-]");
  static final int MAX_STEM = 48;
  static final int HASH_LENGTH = 12;

  private SafeNames() {}

  /**
   * The identifier reduced to {@code [A-Za-z0-9._-]}, at most 48 characters, starting with a
   * letter, digit, or underscore: a leading dot or dash is replaced, so the name is never hidden
   * and never read as an option, and an empty stem becomes an underscore.
   */
  static String stem(String id) {
    String safe = UNSAFE.matcher(id).replaceAll("_");
    if (safe.isEmpty()) {
      return "_";
    }
    char first = safe.charAt(0);
    if (!(Character.isLetterOrDigit(first) && first < 128) && first != '_') {
      safe = "_" + safe.substring(1);
    }
    return safe.length() > MAX_STEM ? safe.substring(0, MAX_STEM) : safe;
  }

  /** The first 12 lowercase hex digits of the SHA-256 of the original identifier. */
  static String hash(String id) {
    return HexFormat.of()
        .formatHex(FileSink.sha256().digest(id.getBytes(StandardCharsets.UTF_8)))
        .substring(0, HASH_LENGTH);
  }
}
