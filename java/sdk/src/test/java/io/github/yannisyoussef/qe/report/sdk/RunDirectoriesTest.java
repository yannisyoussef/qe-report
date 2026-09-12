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
                assertTrue(SAFE.matcher(name).matches(), name);
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
            "a b")) {
      Path dir = RunDirectories.resolve(root, id).toAbsolutePath().normalize();
      assertTrue(dir.startsWith(runs), id);
      assertEquals(runs, dir.getParent(), id);
      assertFalse(dir.getFileName().toString().contains("/"), id);
      assertFalse(dir.getFileName().toString().contains("\\"), id);
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
