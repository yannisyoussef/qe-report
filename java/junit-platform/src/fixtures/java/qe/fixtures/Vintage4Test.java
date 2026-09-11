package qe.fixtures;

public class Vintage4Test {
  @org.junit.Test
  public void passes4() {}

  @org.junit.Test
  public void fails4() {
    org.junit.Assert.assertEquals(1, 2);
  }

  @org.junit.Ignore("old")
  @org.junit.Test
  public void ignored4() {}
}
