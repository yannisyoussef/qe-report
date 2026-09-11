package io.github.yannisyoussef.qe.report.protocol.testing;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;

/** Access to the protocol fixture corpus and a test-only canonical JSON form. */
public final class Corpus {
  private static final JsonMapper MAPPER = JsonMapper.builder().build();

  private Corpus() {}

  /** The {@code protocol} directory, passed by Gradle as a system property. */
  public static Path protocolDir() {
    String p = System.getProperty("qe.protocolDir");
    if (p == null) {
      throw new IllegalStateException("system property qe.protocolDir is not set");
    }
    return Path.of(p);
  }

  public static Path fixtures() {
    return protocolDir().resolve("fixtures");
  }

  public static Path schema() {
    return protocolDir().resolve("schema").resolve("event.schema.json");
  }

  public static JsonNode manifest() {
    return readJson(fixtures().resolve("manifest.json"));
  }

  public static JsonNode readJson(Path file) {
    try {
      return MAPPER.readTree(Files.readString(file, StandardCharsets.UTF_8));
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  public static String readText(Path file) {
    try {
      return Files.readString(file, StandardCharsets.UTF_8);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  /** Session files of a run directory, in name order. */
  public static List<Path> sessionFiles(Path runDir) {
    try (Stream<Path> files = Files.list(runDir.resolve("events"))) {
      return files.filter(p -> p.getFileName().toString().endsWith(".ndjson")).sorted().toList();
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  /** Non-blank lines of one event file. */
  public static List<String> lines(Path file) {
    try {
      List<String> out = new ArrayList<>();
      for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
        if (!line.isBlank()) {
          out.add(line);
        }
      }
      return out;
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  /** Non-blank lines of every session file of a run, file by file. */
  public static List<String> runLines(Path runDir) {
    List<String> out = new ArrayList<>();
    for (Path f : sessionFiles(runDir)) {
      out.addAll(lines(f));
    }
    return out;
  }

  /**
   * Test-only canonical form: object keys sorted recursively, then compact JSON. Used to compare
   * outputs; it is not a wire-format guarantee.
   */
  public static String canonical(String json) {
    try {
      return MAPPER.writeValueAsString(sorted(MAPPER.readTree(json)));
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  private static Object sorted(JsonNode node) {
    if (node.isObject()) {
      Map<String, Object> map = new TreeMap<>();
      node.properties().forEach(e -> map.put(e.getKey(), sorted(e.getValue())));
      return map;
    }
    if (node.isArray()) {
      List<Object> list = new ArrayList<>();
      node.forEach(n -> list.add(sorted(n)));
      return list;
    }
    if (node.isNumber()) {
      return node.numberValue();
    }
    if (node.isBoolean()) {
      return node.booleanValue();
    }
    if (node.isNull()) {
      return null;
    }
    return node.textValue();
  }
}
