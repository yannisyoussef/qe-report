package io.github.yannisyoussef.qe.report.sdk;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import io.github.yannisyoussef.qe.report.protocol.Event;
import io.github.yannisyoussef.qe.report.protocol.ProtocolJson;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HexFormat;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class FileSinkTest {
  private static final Event EVENT =
      ProtocolJson.read(
          "{\"protocolVersion\":\"0.1.0\",\"eventId\":\"e-1\",\"eventType\":\"session.finished\","
              + "\"runId\":\"r\",\"sessionId\":\"s\",\"sequence\":1,\"occurredAt\":\"2026-01-01T00:00:00.000Z\",\"payload\":{}}");

  private static String sha(byte[] b) {
    return HexFormat.of().formatHex(FileSink.sha256().digest(b));
  }

  @Test
  void writesEachEventAsOneFlushedLine(@TempDir Path dir) throws IOException {
    try (FileSink sink = FileSink.open(dir)) {
      sink.write(EVENT);
      assertEquals(
          ProtocolJson.write(EVENT) + "\n", Files.readString(dir.resolve("events.ndjson")));
      sink.write(EVENT);
      assertEquals(2, Files.readAllLines(dir.resolve("events.ndjson")).size());
    }
  }

  @Test
  void namesAttachmentsByHashOnly(@TempDir Path dir) throws IOException {
    byte[] bytes = "hello".getBytes(StandardCharsets.UTF_8);
    try (FileSink sink = FileSink.open(dir)) {
      ReportSink.StoredAttachment stored = sink.storeAttachment(new ByteArrayInputStream(bytes));
      assertEquals(new ReportSink.StoredAttachment(sha(bytes), 5), stored);
      assertEquals(stored, sink.storeAttachment(new ByteArrayInputStream(bytes)));
      assertEquals(List.of(sha(bytes)), list(dir.resolve("attachments")));
      assertEquals(List.of("attachments", "events.ndjson"), list(dir));
      assertArrayEquals(bytes, Files.readAllBytes(dir.resolve("attachments").resolve(sha(bytes))));
    }
  }

  @Test
  void rejectsOversizedAttachmentAndLeavesNothingBehind(@TempDir Path dir) throws IOException {
    try (FileSink sink = FileSink.open(dir, 4)) {
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
  void refusesWritesAfterClose(@TempDir Path dir) throws IOException {
    FileSink sink = FileSink.open(dir);
    sink.close();
    assertThrows(IOException.class, () -> sink.write(EVENT));
  }

  private static List<String> list(Path dir) throws IOException {
    try (Stream<Path> s = Files.list(dir)) {
      return s.map(p -> p.getFileName().toString()).sorted().toList();
    }
  }
}
