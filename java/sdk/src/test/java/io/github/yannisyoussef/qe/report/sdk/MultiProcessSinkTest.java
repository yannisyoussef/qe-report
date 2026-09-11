package io.github.yannisyoussef.qe.report.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.yannisyoussef.qe.report.protocol.Event;
import io.github.yannisyoussef.qe.report.protocol.ProtocolJson;
import io.github.yannisyoussef.qe.report.protocol.testing.Corpus;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Several JVM processes, as Gradle and Surefire forks would be, writing one run directory. */
class MultiProcessSinkTest {
  @Test
  void eachProcessOwnsASessionFileAndAttachmentsAreShared(@TempDir Path dir) throws Exception {
    int workers = 5;
    int rounds = 6;
    String javaExecutable = ProcessHandle.current().info().command().orElseThrow();
    String classpath = System.getProperty("java.class.path");
    List<Process> processes = new ArrayList<>();
    for (int i = 0; i < workers; i++) {
      processes.add(
          new ProcessBuilder(
                  javaExecutable,
                  "-cp",
                  classpath,
                  MultiProcessWorker.class.getName(),
                  dir.toString(),
                  "worker-" + i,
                  String.valueOf(rounds))
              .redirectErrorStream(true)
              .start());
    }
    for (Process p : processes) {
      String output = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
      assertTrue(p.waitFor(2, TimeUnit.MINUTES), "worker finished");
      assertEquals(0, p.exitValue(), output);
    }
    List<String> sessionFiles = FileSinkTest.list(dir.resolve("events"));
    assertEquals(workers, sessionFiles.size());
    List<String> names = FileSinkTest.list(dir.resolve("attachments"));
    assertTrue(
        names.stream().noneMatch(n -> n.startsWith(".tmp-")), "no temporary files left: " + names);
    assertEquals(1 + workers * rounds, names.size());
    for (String n : names) {
      assertEquals(n, FileSinkTest.sha(Files.readAllBytes(dir.resolve("attachments").resolve(n))));
    }
    Set<String> sessions = new HashSet<>();
    int attempts = 0;
    for (Path file : Corpus.sessionFiles(dir)) {
      Set<String> inFile = new HashSet<>();
      long expected = 1;
      for (String line : Corpus.lines(file)) {
        Event e = ProtocolJson.read(line);
        inFile.add(e.sessionId());
        assertEquals(expected++, e.sequence(), "contiguous sequence in " + file.getFileName());
        if (e.eventType().equals("attempt.finished")) {
          attempts++;
        }
      }
      assertEquals(1, inFile.size(), "one session per file");
      sessions.addAll(inFile);
    }
    assertEquals(workers, sessions.size());
    assertEquals(workers * rounds, attempts);
  }
}
