package qe.fixtures;

import static org.junit.jupiter.api.Assertions.fail;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.parallel.Execution;
import org.junit.jupiter.api.parallel.ExecutionMode;

/** Four classes of ten tests each; every third test fails. */
public final class ParallelFixtures {
  private ParallelFixtures() {}

  static void body(int n) throws InterruptedException {
    Thread.sleep(3);
    if (n % 3 == 0) {
      fail("test " + n + " failed");
    }
  }

  @Execution(ExecutionMode.CONCURRENT)
  public static class A {
    @Test
    public void t1() throws Exception {
      body(1);
    }

    @Test
    public void t2() throws Exception {
      body(2);
    }

    @Test
    public void t3() throws Exception {
      body(3);
    }

    @Test
    public void t4() throws Exception {
      body(4);
    }

    @Test
    public void t5() throws Exception {
      body(5);
    }

    @Test
    public void t6() throws Exception {
      body(6);
    }

    @Test
    public void t7() throws Exception {
      body(7);
    }

    @Test
    public void t8() throws Exception {
      body(8);
    }

    @Test
    public void t9() throws Exception {
      body(9);
    }

    @Test
    public void t10() throws Exception {
      body(10);
    }
  }

  @Execution(ExecutionMode.CONCURRENT)
  public static class B extends A {}

  @Execution(ExecutionMode.CONCURRENT)
  public static class C extends A {}

  @Execution(ExecutionMode.CONCURRENT)
  public static class D extends A {}
}
