package qe.fixtures;

import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.api.DynamicContainer.dynamicContainer;
import static org.junit.jupiter.api.DynamicTest.dynamicTest;

import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicContainer;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

public class DynamicTests {
  @TestFactory
  public Stream<DynamicTest> dyn() {
    return Stream.of(dynamicTest("d1", () -> {}), dynamicTest("d2", () -> fail("dyn fail")));
  }

  @TestFactory
  public Stream<DynamicContainer> dynContainer() {
    return Stream.of(
        dynamicContainer("container", Stream.of(dynamicTest("in-container", () -> {}))));
  }
}
