package qe.fixtures;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

@Disabled("class off")
public class DisabledContainer {
  @Test
  public void a() {}

  @Test
  public void b() {}

  @Nested
  public class Inner {
    @Test
    public void c() {}
  }
}
