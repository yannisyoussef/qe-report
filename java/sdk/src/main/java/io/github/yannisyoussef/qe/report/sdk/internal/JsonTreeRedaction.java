package io.github.yannisyoussef.qe.report.sdk.internal;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;
import java.util.Map;
import java.util.Set;
import java.util.function.UnaryOperator;

/** Applies a text transformation to the free-text strings of an event's payload. */
public final class JsonTreeRedaction {
  private static final JsonMapper MAPPER = JsonMapper.builder().build();

  /**
   * Property names whose string values are structural, never free text. Their values are left
   * untouched at any depth, including as map values.
   */
  public static final Set<String> STRUCTURAL_KEYS =
      Set.of(
          "attemptId",
          "stepId",
          "parentStepId",
          "executionId",
          "historicalId",
          "historicalIdStability",
          "status",
          "rawStatus",
          "expectedStatus",
          "mediaType",
          "sha256",
          "kind",
          "phase",
          "version");

  private JsonTreeRedaction() {}

  public static String redactPayloadStrings(String eventJson, UnaryOperator<String> text) {
    try {
      JsonNode root = MAPPER.readTree(eventJson);
      JsonNode payload = root.get("payload");
      if (payload instanceof ObjectNode o) {
        walk(o, text);
      }
      return MAPPER.writeValueAsString(root);
    } catch (JsonProcessingException e) {
      throw new IllegalStateException("event JSON produced by the codec is not parseable", e);
    }
  }

  private static void walk(ObjectNode o, UnaryOperator<String> text) {
    for (Map.Entry<String, JsonNode> e : o.properties()) {
      if (STRUCTURAL_KEYS.contains(e.getKey())) {
        continue;
      }
      JsonNode v = e.getValue();
      if (v.isTextual()) {
        o.set(e.getKey(), TextNode.valueOf(text.apply(v.textValue())));
      } else if (v instanceof ObjectNode child) {
        walk(child, text);
      } else if (v instanceof ArrayNode arr) {
        walk(arr, text);
      }
    }
  }

  private static void walk(ArrayNode arr, UnaryOperator<String> text) {
    for (int i = 0; i < arr.size(); i++) {
      JsonNode v = arr.get(i);
      if (v.isTextual()) {
        arr.set(i, TextNode.valueOf(text.apply(v.textValue())));
      } else if (v instanceof ObjectNode child) {
        walk(child, text);
      } else if (v instanceof ArrayNode child) {
        walk(child, text);
      }
    }
  }
}
