package consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

@Tag("consumer")
class FoxtrotTest {
  @Test
  void passes() throws InterruptedException {
    Thread.sleep(20);
  }

  @Test
  void verdict() {
    assertEquals(1, "Foxtrot".equals("Charlie") ? 2 : 1, "Foxtrot verdict");
  }

  @ParameterizedTest
  @ValueSource(ints = {1, 2})
  void parameterized(int value) {
    assertEquals(value, value);
  }

  @Disabled("not in this fixture")
  @Test
  void disabled() {}
}
