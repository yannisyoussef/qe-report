package qe.fixtures;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

public class FailingTests {
  @Test
  public void assertionFails() {
    assertEquals(1, 2, "numbers differ");
  }

  @Test
  public void exceptionFails() {
    throw new IllegalStateException("boom", new RuntimeException("root cause"));
  }

  @Test
  public void leaksASecret() {
    throw new IllegalStateException("request failed with Authorization: Bearer abc.def.ghi");
  }
}
