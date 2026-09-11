package qe.fixtures;

import static org.junit.jupiter.api.Assertions.fail;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.BeforeEachCallback;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.extension.ExtensionContext;

/** Each nested fixture is a top-level class so that a launcher can select it on its own. */
public final class LifecycleFixtures {
  private LifecycleFixtures() {}

  public static class BeforeEachFails {
    @BeforeEach
    public void be() {
      throw new IllegalStateException("beforeEach broke");
    }

    @Test
    public void t() {}
  }

  public static class AfterEachFails {
    @AfterEach
    public void ae() {
      throw new IllegalStateException("afterEach broke");
    }

    @Test
    public void t() {}
  }

  public static class BodyAndAfterEachFail {
    @AfterEach
    public void ae() {
      throw new IllegalStateException("afterEach broke");
    }

    @Test
    public void t() {
      fail("body broke");
    }
  }

  public static class BeforeAllFails {
    @BeforeAll
    public static void ba() {
      throw new IllegalStateException("beforeAll broke");
    }

    @Test
    public void a() {}

    @Test
    public void b() {}

    @org.junit.jupiter.api.Nested
    public class Deeper {
      @Test
      public void c() {}
    }
  }

  public static class AfterAllFails {
    @AfterAll
    public static void aa() {
      throw new IllegalStateException("afterAll broke");
    }

    @Test
    public void a() {}

    @Test
    public void b() {
      fail("b broke");
    }
  }

  public static class ExtensionFails {
    @Test
    @ExtendWith(BrokenExtension.class)
    public void t() {}
  }

  public static class BrokenExtension implements BeforeEachCallback {
    @Override
    public void beforeEach(ExtensionContext context) {
      throw new IllegalStateException("extension beforeEach broke");
    }
  }
}
