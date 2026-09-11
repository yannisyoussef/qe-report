package qe.fixtures;

import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestReporter;

public class ReportingTests {
  @BeforeAll
  public static void ba(TestReporter r) {
    r.publishEntry("scope", "beforeAll container entry");
  }

  @BeforeEach
  public void be(TestReporter r) {
    r.publishEntry("scope", "beforeEach entry");
  }

  @Test
  public void publishes(TestReporter r) {
    r.publishEntry("token", "abc.def.ghi");
    r.publishEntry(Map.of("k1", "v1", "k2", "v2"));
  }

  @AfterAll
  public static void aa(TestReporter r) {
    r.publishEntry("scope", "afterAll container entry");
  }
}
