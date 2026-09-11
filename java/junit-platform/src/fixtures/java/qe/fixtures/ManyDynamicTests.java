package qe.fixtures;

import static org.junit.jupiter.api.DynamicTest.dynamicTest;

import java.util.stream.IntStream;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

public class ManyDynamicTests {
  @TestFactory
  public Stream<DynamicTest> many() {
    return IntStream.range(0, 3000).mapToObj(i -> dynamicTest("dynamic " + i, () -> {}));
  }
}
