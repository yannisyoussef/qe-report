package io.github.yannisyoussef.qe.report.sdk;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.yannisyoussef.qe.report.protocol.Event;
import io.github.yannisyoussef.qe.report.protocol.ProtocolJson;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class FileSinkTest {
  private static final Event EVENT =
      ProtocolJson.read(
          "{\"protocolVersion\":\"0.2.0\",\"eventId\":\"e-1\",\"eventType\":\"session.finished\","
              + "\"runId\":\"r\",\"sessionId\":\"s\",\"sequence\":1,\"occurredAt\":\"2026-01-01T00:00:00.000Z\",\"payload\":{}}");

  static String sha(byte[] b) {
    return HexFormat.of().formatHex(FileSink.sha256().digest(b));
  }

  @Test
  void sessionFileNamesAreSafeAndUnique() {
    assertTrue(SessionFiles.fileName("jvm-1").matches("jvm-1-[0-9a-f]{12}\\.ndjson"));
    assertTrue(
        SessionFiles.fileName("../../etc/passwd")
            .matches("_\\._\\.\\._etc_passwd-[0-9a-f]{12}\\.ndjson"));
    assertTrue(SessionFiles.fileName("..").matches("_\\.-[0-9a-f]{12}\\.ndjson"));
    assertTrue(SessionFiles.fileName(".hidden").startsWith("_hidden-"));
    assertFalse(SessionFiles.fileName("a/b").equals(SessionFiles.fileName("a_b")));
    assertEquals(48 + 1 + 12 + ".ndjson".length(), SessionFiles.fileName("x".repeat(200)).length());
    assertTrue(SessionFiles.fileName("émoji 🚀").startsWith("_moji__-"));
  }

  @Test
  void writesEachEventAsOneFlushedLineIntoItsSessionFile(@TempDir Path dir) throws IOException {
    try (FileSink sink = FileSink.open(dir, "s")) {
      sink.write(EVENT);
      Path file = dir.resolve("events").resolve(SessionFiles.fileName("s"));
      assertEquals(file, sink.eventFile());
      assertEquals(ProtocolJson.write(EVENT) + "\n", Files.readString(file));
      sink.write(EVENT);
      assertEquals(2, Files.readAllLines(file).size());
    }
  }

  @Test
  void refusesToOpenASessionFileThatAlreadyExists(@TempDir Path dir) throws IOException {
    FileSink first = FileSink.open(dir, "same");
    assertThrows(FileAlreadyExistsException.class, () -> FileSink.open(dir, "same"));
    first.close();
    assertThrows(FileAlreadyExistsException.class, () -> FileSink.open(dir, "same"));
    FileSink.open(dir, "other").close();
    assertEquals(2, list(dir.resolve("events")).size());
  }

  @Test
  void namesAttachmentsByHashOnly(@TempDir Path dir) throws IOException {
    byte[] bytes = "hello".getBytes(StandardCharsets.UTF_8);
    try (FileSink sink = FileSink.open(dir, "s")) {
      ReportSink.StoredAttachment stored = sink.storeAttachment(new ByteArrayInputStream(bytes));
      assertEquals(new ReportSink.StoredAttachment(sha(bytes), 5), stored);
      assertEquals(stored, sink.storeAttachment(new ByteArrayInputStream(bytes)));
      assertEquals(List.of(sha(bytes)), list(dir.resolve("attachments")));
      assertEquals(List.of("attachments", "events"), list(dir));
      assertArrayEquals(bytes, Files.readAllBytes(dir.resolve("attachments").resolve(sha(bytes))));
    }
  }

  @Test
  void rejectsOversizedAttachmentAndLeavesNothingBehind(@TempDir Path dir) throws IOException {
    try (FileSink sink = FileSink.open(dir, "s", 4)) {
      assertEquals(4, sink.maxAttachmentBytes());
      assertThrows(
          ReportSink.AttachmentTooLargeException.class,
          () ->
              sink.storeAttachment(
                  new ByteArrayInputStream("12345".getBytes(StandardCharsets.UTF_8))));
      assertEquals(List.of(), list(dir.resolve("attachments")));
      assertEquals(
          4,
          sink.storeAttachment(new ByteArrayInputStream("1234".getBytes(StandardCharsets.UTF_8)))
              .sizeBytes());
    }
  }

  @Test
  void manySinksPublishIdenticalAndDistinctBytesConcurrently(@TempDir Path dir) throws Exception {
    byte[] shared = new byte[256 * 1024];
    Arrays.fill(shared, (byte) 7);
    int sinks = 16;
    ExecutorService pool = Executors.newFixedThreadPool(sinks);
    try {
      List<Callable<List<ReportSink.StoredAttachment>>> tasks = new ArrayList<>();
      for (int i = 0; i < sinks; i++) {
        int n = i;
        tasks.add(
            () -> {
              try (FileSink sink = FileSink.open(dir, "s-" + n)) {
                List<ReportSink.StoredAttachment> out = new ArrayList<>();
                for (int round = 0; round < 5; round++) {
                  out.add(sink.storeAttachment(new ByteArrayInputStream(shared)));
                  out.add(
                      sink.storeAttachment(
                          new ByteArrayInputStream(
                              ("unique " + n).getBytes(StandardCharsets.UTF_8))));
                }
                return out;
              }
            });
      }
      List<ReportSink.StoredAttachment> all = new ArrayList<>();
      for (Future<List<ReportSink.StoredAttachment>> f : pool.invokeAll(tasks)) {
        all.addAll(f.get());
      }
      List<String> names = list(dir.resolve("attachments"));
      assertTrue(
          names.stream().noneMatch(n -> n.startsWith(".tmp-")),
          "no temporary files left: " + names);
      assertEquals(1 + sinks, names.size());
      for (String n : names) {
        assertEquals(n, sha(Files.readAllBytes(dir.resolve("attachments").resolve(n))));
      }
      assertEquals(sinks * 5L, all.stream().filter(a -> a.sha256().equals(sha(shared))).count());
    } finally {
      pool.shutdownNow();
    }
  }

  @Test
  void refusesWritesAfterClose(@TempDir Path dir) throws IOException {
    FileSink sink = FileSink.open(dir, "s");
    sink.close();
    assertThrows(IOException.class, () -> sink.write(EVENT));
  }

  static List<String> list(Path dir) throws IOException {
    try (Stream<Path> s = Files.list(dir)) {
      return s.map(p -> p.getFileName().toString()).sorted().toList();
    }
  }
}
