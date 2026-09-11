package qe.fixtures;

import static org.junit.jupiter.api.Assertions.fail;

import org.junit.jupiter.api.RepeatedTest;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

public class ParameterizedTests {
  @ParameterizedTest
  @ValueSource(ints = {1, 2})
  public void param(int i) {
    if (i == 2) {
      fail("i=2");
    }
  }

  @ParameterizedTest(name = "value {0}")
  @ValueSource(strings = {"a", "b"})
  public void named(String s) {}

  @ParameterizedTest
  @ValueSource(ints = {1})
  public void overloaded(int i) {}

  @ParameterizedTest
  @ValueSource(strings = {"x"})
  public void overloaded(String s) {}

  @RepeatedTest(2)
  public void repeated() {}
}
