package io.github.yannisyoussef.qe.report.junitplatform;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.yannisyoussef.qe.report.junitplatform.LauncherRuns.Attempt;
import io.github.yannisyoussef.qe.report.junitplatform.LauncherRuns.Result;
import io.github.yannisyoussef.qe.report.protocol.AttachmentAdded;
import io.github.yannisyoussef.qe.report.protocol.Failure;
import io.github.yannisyoussef.qe.report.protocol.FailurePhase;
import io.github.yannisyoussef.qe.report.protocol.HistoricalIdStability;
import io.github.yannisyoussef.qe.report.protocol.PathSegment;
import io.github.yannisyoussef.qe.report.protocol.SessionStarted;
import io.github.yannisyoussef.qe.report.protocol.Status;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.platform.launcher.Launcher;

/** One real Launcher run over every fixture, then the durable mapping promises. */
class LifecycleMappingTest {
  private static Result run;

  @BeforeAll
  static void execute(@TempDir Path dir) {
    run =
        LauncherRuns.run(
            dir,
            qe.fixtures.PassingTests.class,
            qe.fixtures.FailingTests.class,
            qe.fixtures.SkippedTests.class,
            qe.fixtures.NestedTests.class,
            qe.fixtures.ParameterizedTests.class,
            qe.fixtures.DynamicTests.class,
            qe.fixtures.LifecycleFixtures.BeforeEachFails.class,
            qe.fixtures.LifecycleFixtures.AfterEachFails.class,
            qe.fixtures.LifecycleFixtures.BodyAndAfterEachFail.class,
            qe.fixtures.LifecycleFixtures.BeforeAllFails.class,
            qe.fixtures.LifecycleFixtures.AfterAllFails.class,
            qe.fixtures.LifecycleFixtures.ExtensionFails.class,
            qe.fixtures.DisabledContainer.class,
            qe.fixtures.ReportingTests.class);
  }

  @Test
  void sessionDeclaresProducerAndRunner() {
    SessionStarted s = (SessionStarted) run.sessionStarted().orElseThrow().payload();
    assertEquals("qe-report-junit-platform", s.producer().name());
    assertEquals(System.getProperty("qe.adapterVersion"), s.producer().version());
    assertNotNull(s.runner());
    assertEquals("junit-platform", s.runner().name());
    assertEquals(Launcher.class.getPackage().getImplementationVersion(), s.runner().version());
    assertEquals(List.of("java.version"), List.copyOf(s.environment().keySet()));
    assertEquals("session.finished", run.events().get(run.events().size() - 1).eventType());
    assertTrue(
        run.events().stream().noneMatch(e -> e.eventType().equals("run.finished")),
        "a fork never closes the run");
  }

  @Test
  void ordinaryTestsPassWithStableIdentityAndTags() {
    Attempt a = run.one("passes()");
    assertEquals(Status.PASSED, a.finished().status());
    assertEquals("SUCCESSFUL", a.finished().rawStatus());
    assertEquals(1, a.started().attemptNumber());
    assertNotNull(a.finished().durationMs());
    assertEquals(
        "junit-jupiter:qe.fixtures.PassingTests#passes()", a.started().test().historicalId());
    assertEquals(HistoricalIdStability.STABLE, a.started().test().historicalIdStability());
    assertEquals(
        List.of(
            new PathSegment("engine", "junit-jupiter"),
            new PathSegment("class", "qe.fixtures.PassingTests")),
        a.started().test().path());
    assertEquals("method", a.started().test().labels().get("junit.segmentType"));
    assertEquals("junit-jupiter", a.started().test().labels().get("junit.engine"));
    assertTrue(a.started().test().labels().get("junit.uniqueId").endsWith("[method:passes()]"));
    assertNull(a.started().test().location(), "JUnit gives no file or line for a method");
    assertEquals(
        List.of("fast", "smoke"),
        run.one("tagged()").started().test().tags().stream().sorted().toList());
    assertEquals(
        "a display name with spaces",
        run.one("a display name with spaces").started().test().displayName());
    assertTrue(a.started().test().executionId().startsWith("junit-"));
    assertTrue(a.started().test().executionId().length() <= 128);
  }

  @Test
  void failuresCarryTypeMessageStackTraceAndPhase() {
    Failure assertion = run.one("assertionFails()").finished().failures().get(0);
    assertEquals(Status.FAILED, run.one("assertionFails()").finished().status());
    assertEquals("org.opentest4j.AssertionFailedError", assertion.type());
    assertTrue(assertion.message().startsWith("numbers differ"));
    assertTrue(assertion.stackTrace().contains("qe.fixtures.FailingTests.assertionFails"));
    assertEquals(FailurePhase.TEST, assertion.phase());
    Failure exception = run.one("exceptionFails()").finished().failures().get(0);
    assertEquals("java.lang.IllegalStateException", exception.type());
    assertEquals("boom", exception.message());
    assertTrue(
        exception.stackTrace().contains("Caused by: java.lang.RuntimeException: root cause"));
    assertEquals(FailurePhase.TEST, exception.phase());
  }

  @Test
  void secretsInFailuresAreRedacted() {
    Failure f = run.one("leaksASecret()").finished().failures().get(0);
    assertEquals("request failed with Authorization: [REDACTED]", f.message());
    assertFalse(f.stackTrace().contains("abc.def.ghi"));
  }

  @Test
  void disabledAndAbortedTestsAreSkippedWithTheirReason() {
    Attempt disabled = run.one("disabled()");
    assertEquals(Status.SKIPPED, disabled.finished().status());
    assertEquals("SKIPPED", disabled.finished().rawStatus());
    assertEquals("not now", disabled.finished().failures().get(0).message());
    assertNull(disabled.finished().durationMs(), "nothing was measured for a test that never ran");
    Attempt aborted = run.one("aborted()");
    assertEquals(Status.SKIPPED, aborted.finished().status());
    assertEquals("ABORTED", aborted.finished().rawStatus());
    assertEquals(
        "org.opentest4j.TestAbortedException", aborted.finished().failures().get(0).type());
    assertTrue(aborted.finished().failures().get(0).message().contains("needs feature X"));
  }

  @Test
  void nestedClassesBecomeClassSegments() {
    Attempt deep = run.one("deepFails()");
    assertEquals(
        List.of(
            new PathSegment("engine", "junit-jupiter"),
            new PathSegment("class", "qe.fixtures.NestedTests"),
            new PathSegment("class", "qe.fixtures.NestedTests$Inner"),
            new PathSegment("class", "qe.fixtures.NestedTests$Inner$Deeper")),
        deep.started().test().path());
    assertEquals(
        "junit-jupiter:qe.fixtures.NestedTests$Inner$Deeper#deepFails()",
        deep.started().test().historicalId());
    assertEquals(HistoricalIdStability.STABLE, deep.started().test().historicalIdStability());
  }

  @Test
  void parameterizedAndRepeatedInvocationsAreUncertain() {
    List<Attempt> param =
        run.attempts().values().stream()
            .filter(
                a ->
                    a.started().test().historicalId() != null
                        && a.started()
                            .test()
                            .historicalId()
                            .startsWith("junit-jupiter:qe.fixtures.ParameterizedTests#param(int)"))
            .toList();
    assertEquals(2, param.size());
    assertEquals(
        List.of(
            "junit-jupiter:qe.fixtures.ParameterizedTests#param(int)[#1]",
            "junit-jupiter:qe.fixtures.ParameterizedTests#param(int)[#2]"),
        param.stream().map(a -> a.started().test().historicalId()).sorted().toList());
    assertTrue(
        param.stream()
            .allMatch(
                a ->
                    a.started().test().historicalIdStability() == HistoricalIdStability.UNCERTAIN));
    assertEquals(
        new PathSegment("group", "param(int)"), param.get(0).started().test().path().get(2));
    assertEquals(
        "test-template-invocation",
        param.get(0).started().test().labels().get("junit.segmentType"));
    assertEquals(1, param.stream().filter(a -> a.finished().status() == Status.FAILED).count());
    assertEquals(
        List.of(
            "junit-jupiter:qe.fixtures.ParameterizedTests#overloaded(int)[#1]",
            "junit-jupiter:qe.fixtures.ParameterizedTests#overloaded(java.lang.String)[#1]"),
        run.attempts().values().stream()
            .map(a -> a.started().test().historicalId())
            .filter(h -> h != null && h.contains("overloaded"))
            .sorted()
            .toList());
    assertEquals(
        2,
        run.attempts().values().stream()
            .filter(
                a ->
                    "junit-jupiter:qe.fixtures.ParameterizedTests#repeated()[#1]"
                            .equals(a.started().test().historicalId())
                        || "junit-jupiter:qe.fixtures.ParameterizedTests#repeated()[#2]"
                            .equals(a.started().test().historicalId()))
            .count());
  }

  @Test
  void dynamicTestsHaveNoHistoricalIdentity() {
    for (String name : List.of("d1", "d2", "in-container")) {
      Attempt a = run.one(name);
      assertNull(a.started().test().historicalId());
      assertEquals(HistoricalIdStability.UNAVAILABLE, a.started().test().historicalIdStability());
    }
    assertEquals(Status.FAILED, run.one("d2").finished().status());
    assertEquals(
        new PathSegment("group", "container"),
        run.one("in-container").started().test().path().get(3));
  }

  @Test
  void perTestHookFailuresCarryTheirPhase() {
    assertEquals(FailurePhase.SETUP, phaseOf("qe.fixtures.LifecycleFixtures$BeforeEachFails#t()"));
    assertEquals(
        FailurePhase.TEARDOWN, phaseOf("qe.fixtures.LifecycleFixtures$AfterEachFails#t()"));
    assertEquals(
        FailurePhase.TEST, phaseOf("qe.fixtures.LifecycleFixtures$BodyAndAfterEachFail#t()"));
    assertEquals(FailurePhase.SETUP, phaseOf("qe.fixtures.LifecycleFixtures$ExtensionFails#t()"));
    assertEquals(
        "afterEach broke",
        byHistory("qe.fixtures.LifecycleFixtures$AfterEachFails#t()")
            .finished()
            .failures()
            .get(0)
            .message());
  }

  @Test
  void beforeAllFailurePreventsPlannedTestsWhichAreReportedAsSetupFailures() {
    List<Attempt> prevented =
        run.attempts().values().stream()
            .filter(
                a ->
                    a.started().test().path().stream()
                        .anyMatch(p -> p.name().contains("BeforeAllFails")))
            .toList();
    assertEquals(
        List.of("a()", "b()", "c()"),
        prevented.stream().map(a -> a.started().test().displayName()).sorted().toList());
    for (Attempt a : prevented) {
      assertEquals(Status.FAILED, a.finished().status());
      assertEquals("FAILED", a.finished().rawStatus());
      assertEquals(FailurePhase.SETUP, a.finished().failures().get(0).phase());
      assertEquals("beforeAll broke", a.finished().failures().get(0).message());
      assertNull(a.finished().durationMs());
    }
  }

  @Test
  void afterAllFailureIsNotAttributedToTestsAndIsReportedVisibly() {
    assertEquals(
        Status.PASSED,
        byHistory("qe.fixtures.LifecycleFixtures$AfterAllFails#a()").finished().status());
    assertEquals(
        Status.FAILED,
        byHistory("qe.fixtures.LifecycleFixtures$AfterAllFails#b()").finished().status());
    assertEquals(
        2,
        run.attempts().values().stream()
            .filter(
                a ->
                    a.started().test().path().stream()
                        .anyMatch(p -> p.name().contains("AfterAllFails")))
            .count());
    assertTrue(run.log().contains("AfterAllFails' failed after its tests completed"), run.log());
    assertTrue(run.log().contains("afterAll broke"), run.log());
  }

  @Test
  void disabledContainerReportsItsPlannedTestsAsSkipped() {
    List<Attempt> skipped =
        run.attempts().values().stream()
            .filter(
                a ->
                    a.started().test().path().stream()
                        .anyMatch(p -> p.name().contains("DisabledContainer")))
            .toList();
    assertEquals(
        List.of("a()", "b()", "c()"),
        skipped.stream().map(a -> a.started().test().displayName()).sorted().toList());
    for (Attempt a : skipped) {
      assertEquals(Status.SKIPPED, a.finished().status());
      assertEquals("class off", a.finished().failures().get(0).message());
    }
  }

  @Test
  void reportEntriesBecomeRedactedTextAttachmentsOnTheirAttempt() throws Exception {
    Attempt a = run.one("publishes(TestReporter)");
    assertEquals(3, a.attachments().size(), "beforeEach entry, test entry, map entry");
    for (var e : a.attachments()) {
      AttachmentAdded att = (AttachmentAdded) e.payload();
      assertEquals("junit-report-entry", att.name());
      assertEquals("text/plain", att.mediaType());
      String text =
          Files.readString(
              run.dir().resolve("attachments").resolve(att.sha256()), StandardCharsets.UTF_8);
      assertTrue(text.startsWith("timestamp: "), text);
      assertFalse(text.contains("abc.def.ghi"), text);
    }
    assertTrue(
        run.attachmentTexts().stream().anyMatch(t -> t.contains("token: [REDACTED]")),
        run.attachmentTexts().toString());
    assertTrue(
        run.log().contains("report entry published outside a test attempt is not recorded"),
        run.log());
  }

  @Test
  void everyPlannedTestIsAccountedForOnce() {
    assertEquals(
        run.summary().getTestsFoundCount(),
        run.attempts().size(),
        "the launcher counts planned children of disabled and failed containers as found");
    assertEquals(
        run.summary().getTestsSucceededCount(),
        run.attempts().values().stream()
            .filter(a -> a.finished().status() == Status.PASSED)
            .count());
  }

  private static FailurePhase phaseOf(String historicalId) {
    return byHistory(historicalId).finished().failures().get(0).phase();
  }

  private static Attempt byHistory(String historicalId) {
    String full = "junit-jupiter:" + historicalId;
    return run.attempts().values().stream()
        .filter(a -> full.equals(a.started().test().historicalId()))
        .findFirst()
        .orElseThrow(() -> new AssertionError("no attempt " + full + " in " + run.names()));
  }
}
