package io.github.yannisyoussef.qe.report.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ProtocolVersionTest {
  @Test
  void supportsOnlyTheZeroOneLine() {
    assertTrue(ProtocolVersion.isSupported("0.1.0"));
    assertTrue(ProtocolVersion.isSupported("0.1.99"));
    assertFalse(ProtocolVersion.isSupported("0.2.0"));
    assertFalse(ProtocolVersion.isSupported("1.0.0"));
    assertFalse(ProtocolVersion.isSupported("0.1"));
    assertFalse(ProtocolVersion.isSupported("0.1.0-rc.1"));
  }

  @Test
  void parsesSemanticVersions() {
    assertEquals(new ProtocolVersion.Parsed(0, 1, 7), ProtocolVersion.parse("0.1.7"));
    assertThrows(IllegalArgumentException.class, () -> ProtocolVersion.parse("01.1.0"));
  }

  @Test
  void eventTypeMustMatchPayload() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new Event(
                ProtocolVersion.CURRENT,
                "e",
                EventTypes.RUN_FINISHED,
                "r",
                "s",
                1,
                "2026-01-01T00:00:00Z",
                null,
                new SessionFinished()));
  }

  @Test
  void historicalIdConsistencyIsEnforcedByTheModel() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new TestCase(
                "t",
                "h",
                HistoricalIdStability.UNAVAILABLE,
                "n",
                java.util.List.of(),
                null,
                java.util.List.of(),
                java.util.Map.of()));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new TestCase(
                "t",
                null,
                HistoricalIdStability.STABLE,
                "n",
                java.util.List.of(),
                null,
                java.util.List.of(),
                java.util.Map.of()));
  }
}
