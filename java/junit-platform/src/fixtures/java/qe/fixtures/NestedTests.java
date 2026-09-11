package qe.fixtures;

import static org.junit.jupiter.api.Assertions.fail;

import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

public class NestedTests {
  @Test
  public void outer() {}

  @Nested
  public class Inner {
    @Test
    public void innerPasses() {}

    @Nested
    public class Deeper {
      @Test
      public void deepFails() {
        fail("deep failure");
      }
    }
  }
}
