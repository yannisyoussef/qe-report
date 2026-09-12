package io.github.yannisyoussef.qe.report.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.DynamicTest.dynamicTest;

import com.fasterxml.jackson.databind.JsonNode;
import io.github.yannisyoussef.qe.report.protocol.testing.Corpus;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

class RunDirectoriesTest {
  private static final Pattern SAFE =
      Pattern.compile("^[A-Za-z0-9_][A-Za-z0-9._-]{0,47}-[0-9a-f]{12}$");
  private static final Pattern RESERVED_DEVICE =
      Pattern.compile("^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)", Pattern.CASE_INSENSITIVE);

  /**
   * What every generated component must satisfy, whatever the identifier. The reserved-name check
   * runs on the stem, before the hash suffix, because a bare reserved stem is followed by the
   * suffix's dash in the full name and would pass the check for the wrong reason.
   */
  private static void assertPortable(String name, String id) {
    assertTrue(SAFE.matcher(name).matches(), id + " -> " + name);
    String stem = name.substring(0, name.length() - 1 - SafeNames.HASH_LENGTH);
    assertFalse(RESERVED_DEVICE.matcher(stem).find(), id + " -> " + name);
    assertFalse(name.endsWith(".") || name.endsWith(" "), id + " -> " + name);
  }

  @TestFactory
  List<DynamicTest> namingContractCorpus() {
    JsonNode cases =
        Corpus.readJson(Corpus.fixtures().resolve("naming/run-directories.json")).get("cases");
    List<DynamicTest> tests = new ArrayList<>();
    for (JsonNode c : cases) {
      String runId = c.get("runId").asText();
      tests.add(
          dynamicTest(
              c.get("note").asText(),
              () -> {
                String name = RunDirectories.directoryName(runId);
                assertEquals(c.get("directory").asText(), name);
                assertPortable(name, runId);
                assertEquals(
                    Path.of("out", "runs", name), RunDirectories.resolve(Path.of("out"), runId));
              }));
    }
    return tests;
  }

  @Test
  void hostileIdentifiersStayBelowTheRunsDirectory() {
    Path root = Path.of("out");
    Path runs = root.resolve("runs").toAbsolutePath().normalize();
    for (String id :
        List.of(
            "../escape",
            "..\\escape",
            "/abs/olute",
            "C:\\evil",
            "a:b",
            "..",
            ".",
            "....//x",
            "x/../../y",
            "~/home",
            "a b",
            "CON",
            "con.",
            "NUL.txt",
            "COM1/x",
            "lpt9.a.b",
            ".CON")) {
      Path dir = RunDirectories.resolve(root, id).toAbsolutePath().normalize();
      assertTrue(dir.startsWith(runs), id);
      assertEquals(runs, dir.getParent(), id);
      String name = dir.getFileName().toString();
      assertFalse(name.contains("/"), id);
      assertFalse(name.contains("\\"), id);
      assertPortable(name, id);
    }
  }

  @Test
  void collidingStemsGetDifferentNamesAndTheSameIdAlwaysTheSame() {
    assertNotEquals(RunDirectories.directoryName("run/a"), RunDirectories.directoryName("run_a"));
    assertEquals(
        RunDirectories.directoryName("build-123"), RunDirectories.directoryName("build-123"));
    assertEquals(
        RunDirectories.directoryName("build-123") + ".ndjson", SessionFiles.fileName("build-123"));
  }
}
