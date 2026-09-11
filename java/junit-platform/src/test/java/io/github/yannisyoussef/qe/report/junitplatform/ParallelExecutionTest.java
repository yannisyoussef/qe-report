package io.github.yannisyoussef.qe.report.junitplatform;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import io.github.yannisyoussef.qe.report.junitplatform.LauncherRuns.Result;
import io.github.yannisyoussef.qe.report.protocol.Status;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Real concurrent Jupiter execution: callbacks arrive from several threads at once. */
class ParallelExecutionTest {
  @Test
  void everyTestIsReportedExactlyOnceUnderConcurrentCallbacks(@TempDir Path dir) {
    Result run =
        LauncherRuns.runParallel(
            dir,
            qe.fixtures.ParallelFixtures.A.class,
            qe.fixtures.ParallelFixtures.B.class,
            qe.fixtures.ParallelFixtures.C.class,
            qe.fixtures.ParallelFixtures.D.class);
    assertEquals(40, run.attempts().size());
    assertEquals(40, run.summary().getTestsFoundCount());
    assertEquals(
        12,
        run.attempts().values().stream()
            .filter(a -> a.finished().status() == Status.FAILED)
            .count());
    assertEquals(
        28,
        run.attempts().values().stream()
            .filter(a -> a.finished().status() == Status.PASSED)
            .count());
    assertFalse(run.log().contains("internal error"), run.log());
  }

  @Test
  void aLargeDynamicPlanIsReportedCompletely(@TempDir Path dir) {
    Result run = LauncherRuns.runParallel(dir, qe.fixtures.ManyDynamicTests.class);
    assertEquals(3000, run.attempts().size());
    assertFalse(run.log().contains("internal error"), run.log());
  }
}
