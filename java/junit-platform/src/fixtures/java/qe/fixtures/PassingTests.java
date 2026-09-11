package qe.fixtures;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

public class PassingTests {
  @Test
  public void passes() {}

  @Test
  @Tag("smoke")
  @Tag("fast")
  public void tagged() {}

  @Test
  @DisplayName("a display name with spaces")
  public void named() {}
}
