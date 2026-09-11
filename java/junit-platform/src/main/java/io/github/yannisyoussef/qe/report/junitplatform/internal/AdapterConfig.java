package io.github.yannisyoussef.qe.report.junitplatform.internal;

import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * The four settings the adapter needs. A system property wins over an environment variable, which
 * wins over the default: properties are set per JVM by the build tool, variables are inherited by
 * every fork.
 *
 * <table>
 * <tr><th>System property</th><th>Environment variable</th><th>Default</th></tr>
 * <tr><td>{@code qe.report.enabled}</td><td>{@code QE_REPORT_ENABLED}</td><td>{@code true}</td></tr>
 * <tr><td>{@code qe.report.dir}</td><td>{@code QE_REPORT_DIR}</td><td>{@code qe-report} under the working directory</td></tr>
 * <tr><td>{@code qe.report.runId}</td><td>{@code QE_REPORT_RUN_ID}</td><td>generated: this JVM becomes a run of its own</td></tr>
 * <tr><td>{@code qe.report.sessionId}</td><td>{@code QE_REPORT_SESSION_ID}</td><td>generated from the process id and random bytes</td></tr>
 * </table>
 *
 * @param notes what was ignored or generated, for the diagnostics log
 */
public record AdapterConfig(
    boolean enabled, Path runDirectory, String runId, String sessionId, List<String> notes) {

  public static final String ENABLED_PROPERTY = "qe.report.enabled";
  public static final String DIR_PROPERTY = "qe.report.dir";
  public static final String RUN_ID_PROPERTY = "qe.report.runId";
  public static final String SESSION_ID_PROPERTY = "qe.report.sessionId";
  public static final String ENABLED_VARIABLE = "QE_REPORT_ENABLED";
  public static final String DIR_VARIABLE = "QE_REPORT_DIR";
  public static final String RUN_ID_VARIABLE = "QE_REPORT_RUN_ID";
  public static final String SESSION_ID_VARIABLE = "QE_REPORT_SESSION_ID";
  public static final String DEFAULT_DIRECTORY = "qe-report";

  private static final Pattern IDENTIFIER = Pattern.compile("^[\\x21-\\x7E]{1,128}$");
  private static final SecureRandom RANDOM = new SecureRandom();

  public AdapterConfig {
    notes = List.copyOf(notes);
  }

  public static AdapterConfig fromSystem() {
    return resolve(System.getProperties(), System.getenv());
  }

  /** Resolves the settings from explicit sources; used directly by tests. */
  public static AdapterConfig resolve(Properties properties, Map<String, String> environment) {
    List<String> notes = new ArrayList<>();
    String enabledRaw = pick(properties, ENABLED_PROPERTY, environment, ENABLED_VARIABLE);
    boolean enabled = true;
    if (enabledRaw != null) {
      String v = enabledRaw.trim().toLowerCase(Locale.ROOT);
      if (v.equals("false") || v.equals("0") || v.equals("no") || v.equals("off")) {
        enabled = false;
      } else if (!(v.equals("true") || v.equals("1") || v.equals("yes") || v.equals("on"))) {
        notes.add(
            ENABLED_PROPERTY
                + " has unrecognised value '"
                + enabledRaw
                + "'; reporting stays enabled");
      }
    }
    String dirRaw = pick(properties, DIR_PROPERTY, environment, DIR_VARIABLE);
    Path dir = Path.of(dirRaw == null || dirRaw.isBlank() ? DEFAULT_DIRECTORY : dirRaw.trim());
    String runId =
        identifier(
            pick(properties, RUN_ID_PROPERTY, environment, RUN_ID_VARIABLE),
            RUN_ID_PROPERTY,
            notes);
    if (runId == null) {
      runId = "run-" + UUID.randomUUID();
      notes.add("no " + RUN_ID_PROPERTY + " given; this JVM is run " + runId + " on its own");
    }
    String sessionId =
        identifier(
            pick(properties, SESSION_ID_PROPERTY, environment, SESSION_ID_VARIABLE),
            SESSION_ID_PROPERTY,
            notes);
    if (sessionId == null) {
      byte[] random = new byte[4];
      RANDOM.nextBytes(random);
      sessionId = "junit-" + ProcessHandle.current().pid() + "-" + HexFormat.of().formatHex(random);
    }
    return new AdapterConfig(enabled, dir, runId, sessionId, notes);
  }

  private static @Nullable String identifier(
      @Nullable String raw, String name, List<String> notes) {
    if (raw == null || raw.isBlank()) {
      return null;
    }
    String v = raw.trim();
    if (!IDENTIFIER.matcher(v).matches()) {
      notes.add(
          name
              + " '"
              + v
              + "' is not a valid identifier (printable ASCII, no spaces, at most 128 characters); a generated value is used");
      return null;
    }
    return v;
  }

  private static @Nullable String pick(
      Properties properties, String property, Map<String, String> environment, String variable) {
    String p = properties.getProperty(property);
    if (p != null) {
      return p;
    }
    return environment.get(variable);
  }
}
