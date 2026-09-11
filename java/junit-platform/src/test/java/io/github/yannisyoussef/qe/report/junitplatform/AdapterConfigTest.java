package io.github.yannisyoussef.qe.report.junitplatform;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.yannisyoussef.qe.report.junitplatform.internal.AdapterConfig;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import org.junit.jupiter.api.Test;

class AdapterConfigTest {
  @Test
  void defaultsGenerateARunAndASessionOfTheirOwn() {
    AdapterConfig c = AdapterConfig.resolve(new Properties(), Map.of());
    assertTrue(c.enabled());
    assertEquals(Path.of("qe-report"), c.runDirectory());
    assertTrue(c.runId().startsWith("run-"));
    assertTrue(c.sessionId().matches("junit-[0-9]+-[0-9a-f]{8}"));
    assertNotEquals(c.sessionId(), AdapterConfig.resolve(new Properties(), Map.of()).sessionId());
    assertEquals(1, c.notes().size(), "a generated run id is announced");
  }

  @Test
  void systemPropertyWinsOverEnvironmentWhichWinsOverDefault() {
    Properties p = new Properties();
    p.setProperty(AdapterConfig.DIR_PROPERTY, "/from/property");
    p.setProperty(AdapterConfig.ENABLED_PROPERTY, "false");
    Map<String, String> env =
        Map.of(
            AdapterConfig.DIR_VARIABLE,
            "/from/env",
            AdapterConfig.RUN_ID_VARIABLE,
            "run-env",
            AdapterConfig.SESSION_ID_VARIABLE,
            "sess-env",
            AdapterConfig.ENABLED_VARIABLE,
            "true");
    AdapterConfig c = AdapterConfig.resolve(p, env);
    assertEquals(Path.of("/from/property"), c.runDirectory());
    assertFalse(c.enabled());
    assertEquals("run-env", c.runId());
    assertEquals("sess-env", c.sessionId());
    assertEquals(List.of(), c.notes());
  }

  @Test
  void enabledAcceptsCommonSpellings() {
    for (String v : List.of("false", "0", "no", "off", " FALSE ")) {
      Properties p = new Properties();
      p.setProperty(AdapterConfig.ENABLED_PROPERTY, v);
      assertFalse(AdapterConfig.resolve(p, Map.of()).enabled(), v);
    }
    for (String v : List.of("true", "1", "yes", "on")) {
      Properties p = new Properties();
      p.setProperty(AdapterConfig.ENABLED_PROPERTY, v);
      assertTrue(AdapterConfig.resolve(p, Map.of()).enabled(), v);
    }
  }
}
