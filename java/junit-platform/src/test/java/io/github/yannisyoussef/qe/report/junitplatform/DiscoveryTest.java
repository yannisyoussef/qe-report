package io.github.yannisyoussef.qe.report.junitplatform;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.yannisyoussef.qe.report.junitplatform.internal.AdapterConfig;
import io.github.yannisyoussef.qe.report.sdk.RunDirectories;
import io.github.yannisyoussef.qe.report.sdk.SessionFiles;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.platform.launcher.Launcher;
import org.junit.platform.launcher.core.LauncherConfig;
import org.junit.platform.launcher.core.LauncherFactory;

/** The listener is found through ServiceLoader by a default launcher, and only then. */
class DiscoveryTest {
  @Test
  void aDefaultLauncherDiscoversTheListenerThroughServiceLoader(@TempDir Path dir) {
    withSystemProperties(
        dir,
        "discovered",
        () -> {
          Launcher launcher = LauncherFactory.create();
          launcher.execute(LauncherRuns.request(Map.of(), qe.fixtures.PassingTests.class));
          Path file =
              RunDirectories.resolve(dir, "run-discovery")
                  .resolve("events")
                  .resolve(SessionFiles.fileName("discovered"));
          assertTrue(Files.exists(file), "session file written by the auto-registered listener");
        });
  }

  @Test
  void aLauncherWithAutoRegistrationOffDoesNotReport(@TempDir Path dir) {
    withSystemProperties(
        dir,
        "not-discovered",
        () -> {
          Launcher launcher =
              LauncherFactory.create(
                  LauncherConfig.builder()
                      .enableTestExecutionListenerAutoRegistration(false)
                      .build());
          launcher.execute(LauncherRuns.request(Map.of(), qe.fixtures.PassingTests.class));
          assertFalse(
              Files.exists(dir.resolve(RunDirectories.RUNS_DIR)),
              "nothing is written when the listener is not registered");
        });
  }

  private static void withSystemProperties(Path dir, String sessionId, Runnable body) {
    String enabled = System.getProperty(AdapterConfig.ENABLED_PROPERTY);
    try {
      System.setProperty(AdapterConfig.ENABLED_PROPERTY, "true");
      System.setProperty(AdapterConfig.DIR_PROPERTY, dir.toString());
      System.setProperty(AdapterConfig.RUN_ID_PROPERTY, "run-discovery");
      System.setProperty(AdapterConfig.SESSION_ID_PROPERTY, sessionId);
      body.run();
    } finally {
      if (enabled == null) {
        System.clearProperty(AdapterConfig.ENABLED_PROPERTY);
      } else {
        System.setProperty(AdapterConfig.ENABLED_PROPERTY, enabled);
      }
      System.clearProperty(AdapterConfig.DIR_PROPERTY);
      System.clearProperty(AdapterConfig.RUN_ID_PROPERTY);
      System.clearProperty(AdapterConfig.SESSION_ID_PROPERTY);
    }
  }
}
