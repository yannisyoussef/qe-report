package io.github.yannisyoussef.qe.report.protocol;

import io.github.yannisyoussef.qe.report.protocol.internal.JsonCodec;

/**
 * Reads and writes single events as JSON text, one event per call. A newline-delimited file is a
 * sequence of such texts.
 *
 * <p>Reading checks structure (required fields, JSON types, enumerations) and protocol
 * compatibility. Length limits are the schema's job and are not enforced here. Unknown properties
 * are ignored, as the compatibility rules require.
 */
public final class ProtocolJson {
  private ProtocolJson() {}

  /**
   * Parses one event.
   *
   * @throws ProtocolException with a {@link ProtocolException.Reason} describing the problem
   */
  public static Event read(String json) {
    return JsonCodec.read(json);
  }

  /** Serialises one event as a single line without a trailing newline. */
  public static String write(Event event) {
    return JsonCodec.write(event);
  }
}
