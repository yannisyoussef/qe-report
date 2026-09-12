package io.github.yannisyoussef.qe.report.protocol.testing;

import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.Error;
import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SpecificationVersion;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * The protocol schema loaded into an independent validator (not the one the TypeScript side uses).
 */
public final class Schemas {
  private static final String SCHEMA_ID =
      "https://yannisyoussef.github.io/qe-report/schema/0.3/event.schema.json";
  private static final JsonMapper MAPPER = JsonMapper.builder().build();
  private static final Map<String, Schema> BY_TYPE = new ConcurrentHashMap<>();
  private static final Schema SCHEMA =
      SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12)
          .getSchema(
              SchemaLocation.of(SCHEMA_ID), Corpus.readText(Corpus.schema()), InputFormat.JSON);

  private Schemas() {}

  public static List<Error> errors(String json) {
    return SCHEMA.validate(json, InputFormat.JSON);
  }

  /**
   * Validates against the branch for one event type (the schema without its oneOf, plus a reference
   * to that branch), which yields exact pointers instead of the oneOf's root error.
   */
  public static List<Error> errorsForType(String json, String eventType) {
    return BY_TYPE.computeIfAbsent(eventType, Schemas::typed).validate(json, InputFormat.JSON);
  }

  public static boolean isValid(String json) {
    return errors(json).isEmpty();
  }

  public static String describe(List<Error> errors) {
    return errors.stream()
        .map(e -> pointer(e) + " " + e.getMessage())
        .collect(Collectors.joining("; "));
  }

  /** JSON pointer form of the validator's instance location. */
  public static String pointer(Error e) {
    String p = e.getInstanceLocation().toString();
    if (p.startsWith("$")) {
      p = p.substring(1);
    }
    return p.replace("[", "/").replace("]", "").replace('.', '/');
  }

  private static Schema typed(String eventType) {
    try {
      ObjectNode base = (ObjectNode) MAPPER.readTree(Corpus.readText(Corpus.schema()));
      base.remove("oneOf");
      base.remove("$id");
      base.putArray("allOf").addObject().put("$ref", "#/$defs/event." + eventType);
      return SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12)
          .getSchema(
              SchemaLocation.of(
                  "https://yannisyoussef.github.io/qe-report/schema/0.3/typed/"
                      + eventType
                      + ".schema.json"),
              MAPPER.writeValueAsString(base),
              InputFormat.JSON);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }
}
