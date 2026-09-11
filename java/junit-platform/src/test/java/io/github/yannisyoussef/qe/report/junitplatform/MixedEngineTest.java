package io.github.yannisyoussef.qe.report.junitplatform;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.yannisyoussef.qe.report.junitplatform.LauncherRuns.Attempt;
import io.github.yannisyoussef.qe.report.junitplatform.LauncherRuns.Result;
import io.github.yannisyoussef.qe.report.protocol.HistoricalIdStability;
import io.github.yannisyoussef.qe.report.protocol.PathSegment;
import io.github.yannisyoussef.qe.report.protocol.SessionStarted;
import io.github.yannisyoussef.qe.report.protocol.Status;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Two engines in one plan: one session-level runner, engine-prefixed historical identities. */
class MixedEngineTest {
  @Test
  void enginesShareTheSessionButNeverTheIdentitySpace(@TempDir Path dir) {
    Result run =
        LauncherRuns.run(dir, qe.fixtures.PassingTests.class, qe.fixtures.Vintage4Test.class);
    assertEquals(
        "junit-platform",
        ((SessionStarted) run.sessionStarted().orElseThrow().payload()).runner().name());
    Attempt vintage = run.one("passes4");
    assertEquals(Status.PASSED, vintage.finished().status());
    assertEquals(
        "junit-vintage:qe.fixtures.Vintage4Test#passes4()",
        vintage.started().test().historicalId());
    assertEquals(HistoricalIdStability.STABLE, vintage.started().test().historicalIdStability());
    assertEquals(
        new PathSegment("engine", "junit-vintage"), vintage.started().test().path().get(0));
    assertEquals(
        new PathSegment("class", "qe.fixtures.Vintage4Test"),
        vintage.started().test().path().get(1));
    assertEquals("junit-vintage", vintage.started().test().labels().get("junit.engine"));
    Attempt ignored = run.one("ignored4");
    assertEquals(Status.SKIPPED, ignored.finished().status());
    assertEquals("old", ignored.finished().failures().get(0).message());
    assertEquals(Status.FAILED, run.one("fails4").finished().status());
    List<String> ids =
        run.attempts().values().stream().map(a -> a.started().test().historicalId()).toList();
    assertEquals(
        ids.size(), ids.stream().distinct().count(), "no two attempts share a historical id");
    assertTrue(
        ids.stream()
            .allMatch(id -> id.startsWith("junit-jupiter:") || id.startsWith("junit-vintage:")),
        ids.toString());
  }
}
