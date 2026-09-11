package io.github.yannisyoussef.qe.report.protocol;

import com.networknt.schema.Error;
import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import io.github.yannisyoussef.qe.report.protocol.testing.Corpus;
import java.util.List;
import java.util.stream.Collectors;

/**
 * The protocol schema loaded into an independent validator (not the one the TypeScript side uses).
 */
final class SchemaValidation {
  private static final com.fasterxml.jackson.databind.json.JsonMapper MAPPER =
      com.fasterxml.jackson.databind.json.JsonMapper.builder().build();
  private static final java.util.Map<String, Schema> BY_TYPE =
      new java.util.concurrent.ConcurrentHashMap<>();
  private static final Schema SCHEMA =
      SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12)
          .getSchema(
              SchemaLocation.of(
                  "https://yannisyoussef.github.io/qe-report/schema/0.2/event.schema.json"),
              Corpus.readText(Corpus.schema()),
              InputFormat.JSON);

  private SchemaValidation() {}

  /**
   * Validates against the branch for one event type (the schema without its oneOf, plus a reference
   * to that branch), which yields exact pointers instead of the oneOf's root error.
   */
  static List<Error> errorsForType(String json, String eventType) {
    return BY_TYPE
        .computeIfAbsent(eventType, SchemaValidation::typed)
        .validate(json, InputFormat.JSON);
  }

  private static Schema typed(String eventType) {
    try {
      com.fasterxml.jackson.databind.node.ObjectNode base =
          (com.fasterxml.jackson.databind.node.ObjectNode)
              MAPPER.readTree(Corpus.readText(Corpus.schema()));
      base.remove("oneOf");
      base.remove("$id");
      base.putArray("allOf").addObject().put("$ref", "#/$defs/event." + eventType);
      return SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12)
          .getSchema(
              SchemaLocation.of(
                  "https://yannisyoussef.github.io/qe-report/schema/0.2/typed/"
                      + eventType
                      + ".schema.json"),
              MAPPER.writeValueAsString(base),
              InputFormat.JSON);
    } catch (java.io.IOException e) {
      throw new java.io.UncheckedIOException(e);
    }
  }

  static List<Error> errors(String json) {
    return SCHEMA.validate(json, InputFormat.JSON);
  }

  static boolean isValid(String json) {
    return errors(json).isEmpty();
  }

  static String describe(List<Error> errors) {
    return errors.stream()
        .map(e -> pointer(e) + " " + e.getMessage())
        .collect(Collectors.joining("; "));
  }

  /** JSON pointer form of the validator's instance location. */
  static String pointer(Error e) {
    String p = e.getInstanceLocation().toString();
    if (p.startsWith("$")) {
      p = p.substring(1);
    }
    return p.replace("[", "/").replace("]", "").replace('.', '/');
  }
}
