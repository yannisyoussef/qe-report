package io.github.yannisyoussef.qe.report.junitplatform.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class TextsTest {
  @Test
  void shortTextIsReturnedAsIs() {
    String text = "x".repeat(50);
    assertSame(text, Texts.bounded(text, 50));
  }

  @Test
  void longTextIsBoundedWithAMarkerThatCountsWhatWasDropped() {
    String text = "x".repeat(100);
    String bounded = Texts.bounded(text, 50);
    assertTrue(bounded.length() <= 50, bounded);
    int kept = bounded.indexOf(" [truncated ");
    assertEquals("x".repeat(kept), bounded.substring(0, kept));
    assertEquals(" [truncated " + (100 - kept) + " characters]", bounded.substring(kept));
  }

  @Test
  void aBoundSmallerThanTheMarkerKeepsNothingButTheMarker() {
    String bounded = Texts.bounded("y".repeat(40), 5);
    assertTrue(bounded.startsWith(" [truncated 40 characters]"), bounded);
  }
}
