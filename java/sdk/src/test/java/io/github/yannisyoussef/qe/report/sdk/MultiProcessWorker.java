package io.github.yannisyoussef.qe.report.sdk;

import io.github.yannisyoussef.qe.report.protocol.AttemptFinished;
import io.github.yannisyoussef.qe.report.protocol.AttemptStarted;
import io.github.yannisyoussef.qe.report.protocol.Component;
import io.github.yannisyoussef.qe.report.protocol.HistoricalIdStability;
import io.github.yannisyoussef.qe.report.protocol.SessionStarted;
import io.github.yannisyoussef.qe.report.protocol.Status;
import io.github.yannisyoussef.qe.report.protocol.TestCase;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** Spawned by MultiProcessSinkTest: one producer process writing one session into a shared run. */
public final class MultiProcessWorker {
  private MultiProcessWorker() {}

  public static void main(String[] args) throws Exception {
    Path runDir = Path.of(args[0]);
    String sessionId = args[1];
    int rounds = Integer.parseInt(args[2]);
    byte[] shared = new byte[512 * 1024];
    Arrays.fill(shared, (byte) 42);
    int[] problems = {0};
    try (ReportSession session =
        ReportSession.builder("run-mp", sessionId, FileSink.open(runDir, sessionId))
            .problems(
                p -> {
                  System.err.println(p);
                  problems[0]++;
                })
            .start(
                new SessionStarted(
                    new Component("worker", "0"),
                    new Component("fixture-runner", null),
                    Map.of(),
                    null,
                    null,
                    Map.of()))) {
      for (int i = 0; i < rounds; i++) {
        String attemptId = sessionId + "-a-" + i;
        session.emit(
            new AttemptStarted(
                attemptId,
                1,
                new TestCase(
                    sessionId + "-t-" + i,
                    "suite::t-" + i,
                    HistoricalIdStability.STABLE,
                    "test " + i,
                    List.of(),
                    null,
                    List.of(),
                    Map.of())));
        session.attach(attemptId, null, "shared", "application/octet-stream", shared);
        session.attach(
            attemptId,
            null,
            "own",
            "text/plain",
            (sessionId + " round " + i + " password=x\n").getBytes(StandardCharsets.UTF_8));
        session.emit(AttemptFinished.of(attemptId, Status.PASSED));
      }
    }
    System.exit(problems[0] == 0 ? 0 : 3);
  }
}
