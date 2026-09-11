package io.github.yannisyoussef.qe.report.sdk;

import java.util.Locale;

/** Which media types the SDK treats as text and therefore redacts before storing. */
public final class MediaTypes {
  private MediaTypes() {}

  /**
   * True for {@code text/*}, JSON, XML, form-encoded, and any {@code +json} or {@code +xml}
   * structured syntax. Everything else is stored as opaque bytes and not redacted.
   */
  public static boolean isTextual(String mediaType) {
    String base = mediaType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
    return base.startsWith("text/")
        || base.equals("application/json")
        || base.equals("application/xml")
        || base.equals("application/x-www-form-urlencoded")
        || base.equals("application/javascript")
        || base.endsWith("+json")
        || base.endsWith("+xml");
  }
}
