package qe.fixtures;

import static org.junit.jupiter.api.Assumptions.assumeTrue;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;

public class SkippedTests {
  @Test
  @Disabled("not now")
  public void disabled() {}

  @Test
  public void aborted() {
    assumeTrue(false, "needs feature X");
  }
}
