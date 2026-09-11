package io.github.yannisyoussef.qe.report.sdk;

import io.github.yannisyoussef.qe.report.protocol.Event;
import io.github.yannisyoussef.qe.report.protocol.ProtocolJson;
import io.github.yannisyoussef.qe.report.sdk.internal.JsonTreeRedaction;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Removes secrets from text before it is serialised or written as an attachment.
 *
 * <p>Immutable. Build one with {@link #defaults()} or {@link #builder()} and pass it where needed;
 * there is no global instance. The TypeScript SDK applies the same rules, and both are checked
 * against the shared fixture corpus.
 *
 * <p>Only text is redacted. Bytes of a binary attachment (an image, a video, a trace) are stored as
 * given; a producer that can render such content is responsible for what it captures.
 */
public final class Redactor {
  /** The replacement written in place of a secret. */
  public static final String REDACTED = "[REDACTED]";

  private static final List<String> SENSITIVE_HEADERS =
      List.of(
          "authorization",
          "proxy-authorization",
          "cookie",
          "set-cookie",
          "x-api-key",
          "api-key",
          "x-auth-token",
          "x-access-token",
          "x-amz-security-token",
          "x-session-token");

  private static final List<String> SENSITIVE_KEYS =
      List.of(
          "apikey",
          "api_key",
          "password",
          "passwd",
          "pwd",
          "secret",
          "client_secret",
          "client-secret",
          "clientsecret",
          "token",
          "access_token",
          "access-token",
          "accesstoken",
          "refresh_token",
          "refresh-token",
          "private_key",
          "private-key");

  private static final Pattern PRIVATE_KEY_BLOCK =
      Pattern.compile(
          "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----");
  private static final Pattern URL_USERINFO =
      Pattern.compile("(?i)([a-z][a-z0-9+.-]*://)[^/\\s:@]+:[^/\\s@]+@");
  private static final Pattern BEARER =
      Pattern.compile("(?i)(?<![A-Za-z0-9_])bearer[ \\t]+[A-Za-z0-9\\-._~+/]+=*");
  private static final Pattern JWT =
      Pattern.compile(
          "(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}");
  private static final List<Pattern> WELL_KNOWN_TOKENS =
      List.of(
          Pattern.compile("(?<![A-Za-z0-9_])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9_])"),
          Pattern.compile("(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,}(?![A-Za-z0-9_])"),
          Pattern.compile("(?<![A-Za-z0-9_])xox[abprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9_])"),
          Pattern.compile("(?<![A-Za-z0-9_])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_])"));

  /** A caller-supplied rule: every match of the pattern is replaced by the replacement. */
  public record Rule(Pattern pattern, String replacement) {}

  private final Set<String> headerNames;
  private final Pattern headerValue;
  private final Pattern keyValue;
  private final List<Rule> customRules;

  private Redactor(Set<String> headerNames, Set<String> keys, List<Rule> customRules) {
    this.headerNames = Collections.unmodifiableSet(new LinkedHashSet<>(headerNames));
    this.customRules = List.copyOf(customRules);
    // A header value runs to the end of the line (cookies contain ';'); a key value stops at a
    // delimiter.
    this.headerValue = keyValuePattern(headerNames, "[^\\r\\n]*");
    this.keyValue = keyValuePattern(keys, "[^\\r\\n,;&]*");
  }

  private static Pattern keyValuePattern(Set<String> names, String unquotedValue) {
    StringBuilder alternation = new StringBuilder();
    for (String k : names) {
      if (alternation.length() > 0) {
        alternation.append('|');
      }
      alternation.append(Pattern.quote(k));
    }
    return Pattern.compile(
        "(?i)(?<![A-Za-z0-9_-])([\"']?)("
            + alternation
            + ")\\1([ \\t]*[:=][ \\t]*)(?:\"([^\"\\r\\n]*)\"|'([^'\\r\\n]*)'|("
            + unquotedValue
            + "))");
  }

  /** The built-in rules and nothing else. */
  public static Redactor defaults() {
    return builder().build();
  }

  public static Builder builder() {
    return new Builder();
  }

  /** Whether a header (case-insensitive) is replaced wholesale rather than scanned. */
  public boolean isSensitiveHeader(String name) {
    return headerNames.contains(name.toLowerCase(Locale.ROOT));
  }

  /** Redacts free text: logs, messages, stack traces, textual attachment content. */
  public String redactText(String text) {
    String out = PRIVATE_KEY_BLOCK.matcher(text).replaceAll(REDACTED);
    out = redactKeyValues(headerValue, out);
    out = redactKeyValues(keyValue, out);
    out = URL_USERINFO.matcher(out).replaceAll("$1" + REDACTED + "@");
    out = BEARER.matcher(out).replaceAll("Bearer " + REDACTED);
    out = JWT.matcher(out).replaceAll(REDACTED);
    for (Pattern p : WELL_KNOWN_TOKENS) {
      out = p.matcher(out).replaceAll(REDACTED);
    }
    for (Rule r : customRules) {
      out = r.pattern().matcher(out).replaceAll(Matcher.quoteReplacement(r.replacement()));
    }
    return out;
  }

  /**
   * Redacts a header map: sensitive headers lose their value entirely, others are scanned as text.
   * Key order is preserved.
   */
  public Map<String, String> redactHeaders(Map<String, String> headers) {
    Map<String, String> out = new LinkedHashMap<>();
    headers.forEach(
        (name, value) -> out.put(name, isSensitiveHeader(name) ? REDACTED : redactText(value)));
    return out;
  }

  /**
   * Redacts every free-text string in the payload of an event. Structural values (identifiers,
   * statuses, media types, hashes, kinds, versions) are left untouched; the envelope is never
   * changed.
   */
  public Event redactEvent(Event event) {
    String json = ProtocolJson.write(event);
    String redacted = JsonTreeRedaction.redactPayloadStrings(json, this::redactText);
    return ProtocolJson.read(redacted);
  }

  private static String redactKeyValues(Pattern pattern, String text) {
    Matcher m = pattern.matcher(text);
    StringBuilder sb = new StringBuilder();
    int last = 0;
    while (m.find()) {
      sb.append(text, last, m.start());
      sb.append(m.group(1)).append(m.group(2)).append(m.group(1)).append(m.group(3));
      if (m.group(4) != null) {
        sb.append('"').append(REDACTED).append('"');
      } else if (m.group(5) != null) {
        sb.append('\'').append(REDACTED).append('\'');
      } else {
        sb.append(REDACTED);
      }
      last = m.end();
    }
    sb.append(text, last, text.length());
    return sb.toString();
  }

  /** Builds a {@link Redactor}. Every method returns this builder. */
  public static final class Builder {
    private final Set<String> headerNames = new LinkedHashSet<>(SENSITIVE_HEADERS);
    private final Set<String> keys = new LinkedHashSet<>(SENSITIVE_KEYS);
    private final List<Rule> rules = new ArrayList<>();

    private Builder() {}

    /** Treats another header name (case-insensitive) as sensitive. */
    public Builder sensitiveHeader(String name) {
      headerNames.add(name.toLowerCase(Locale.ROOT));
      return this;
    }

    /**
     * Treats another key (case-insensitive) in {@code key: value} or {@code key=value} text as
     * sensitive.
     */
    public Builder sensitiveKey(String key) {
      keys.add(key.toLowerCase(Locale.ROOT));
      return this;
    }

    /** Adds a rule applied after the built-in ones. */
    public Builder rule(Pattern pattern, String replacement) {
      rules.add(new Rule(pattern, replacement));
      return this;
    }

    public Redactor build() {
      return new Redactor(headerNames, keys, rules);
    }
  }
}
