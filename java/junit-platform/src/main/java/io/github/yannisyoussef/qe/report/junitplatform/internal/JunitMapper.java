package io.github.yannisyoussef.qe.report.junitplatform.internal;

import io.github.yannisyoussef.qe.report.protocol.Failure;
import io.github.yannisyoussef.qe.report.protocol.FailurePhase;
import io.github.yannisyoussef.qe.report.protocol.Location;
import io.github.yannisyoussef.qe.report.protocol.PathSegment;
import io.github.yannisyoussef.qe.report.protocol.Status;
import io.github.yannisyoussef.qe.report.protocol.TestCase;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.jspecify.annotations.Nullable;
import org.junit.platform.engine.TestExecutionResult;
import org.junit.platform.engine.TestSource;
import org.junit.platform.engine.TestTag;
import org.junit.platform.engine.UniqueId;
import org.junit.platform.engine.support.descriptor.ClassSource;
import org.junit.platform.engine.support.descriptor.ClasspathResourceSource;
import org.junit.platform.engine.support.descriptor.FileSource;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;

/** JUnit Platform identifiers, results, and throwables to protocol values. */
final class JunitMapper {
  static final String LABEL_UNIQUE_ID = "junit.uniqueId";
  static final String LABEL_ENGINE = "junit.engine";
  static final String LABEL_SEGMENT_TYPE = "junit.segmentType";
  private static final int MAX_TAGS = 64;
  private static final int MAX_PATH = 32;

  private JunitMapper() {}

  /**
   * The in-run execution identity: a hash of the unique id, which can exceed the identifier limit.
   */
  static String executionId(TestIdentifier id) {
    try {
      byte[] digest =
          MessageDigest.getInstance("SHA-256")
              .digest(id.getUniqueId().getBytes(StandardCharsets.UTF_8));
      return "junit-" + HexFormat.of().formatHex(digest).substring(0, 40);
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 is required by the JVM specification", e);
    }
  }

  static TestCase testCase(TestPlan plan, TestIdentifier id) {
    HistoricalIdentity.Derived history = HistoricalIdentity.derive(plan, id);
    List<UniqueId.Segment> segments = id.getUniqueIdObject().getSegments();
    Map<String, String> labels = new LinkedHashMap<>();
    labels.put(LABEL_UNIQUE_ID, Texts.bounded(id.getUniqueId(), Texts.MAX_LABEL));
    if (!segments.isEmpty()) {
      labels.put(LABEL_ENGINE, Texts.bounded(segments.get(0).getValue(), Texts.MAX_LABEL));
      labels.put(
          LABEL_SEGMENT_TYPE,
          Texts.bounded(segments.get(segments.size() - 1).getType(), Texts.MAX_LABEL));
    }
    List<String> tags = new ArrayList<>();
    for (TestTag t : id.getTags()) {
      if (tags.size() < MAX_TAGS) {
        tags.add(Texts.bounded(t.getName(), Texts.MAX_TAG));
      }
    }
    return new TestCase(
        executionId(id),
        history.id(),
        history.stability(),
        Texts.bounded(id.getDisplayName(), Texts.MAX_DISPLAY),
        path(plan, id),
        location(id.getSource().orElse(null)),
        tags,
        labels);
  }

  /** The runner's own hierarchy above the test, outermost first, as typed segments. */
  static List<PathSegment> path(TestPlan plan, TestIdentifier id) {
    Deque<PathSegment> path = new ArrayDeque<>();
    Optional<TestIdentifier> current = plan.getParent(id);
    while (current.isPresent()) {
      TestIdentifier c = current.get();
      path.addFirst(segment(c));
      current = plan.getParent(c);
    }
    List<PathSegment> out = new ArrayList<>(path);
    return out.size() <= MAX_PATH ? out : out.subList(out.size() - MAX_PATH, out.size());
  }

  private static PathSegment segment(TestIdentifier container) {
    List<UniqueId.Segment> segments = container.getUniqueIdObject().getSegments();
    String type = segments.isEmpty() ? "" : segments.get(segments.size() - 1).getType();
    String name = Texts.bounded(container.getDisplayName(), Texts.MAX_DISPLAY);
    return switch (type) {
      case "engine" ->
          new PathSegment("engine", Texts.bounded(segments.get(0).getValue(), Texts.MAX_DISPLAY));
      case "class", "nested-class", "runner" -> {
        String className =
            container
                .getSource()
                .filter(s -> s instanceof ClassSource)
                .map(s -> ((ClassSource) s).getClassName())
                .orElse(name);
        yield new PathSegment("class", Texts.bounded(className, Texts.MAX_DISPLAY));
      }
      default -> new PathSegment("group", name);
    };
  }

  /**
   * Only sources that carry a file or resource become a location; class and method sources do not.
   */
  static @Nullable Location location(@Nullable TestSource source) {
    if (source instanceof FileSource f) {
      return new Location(
          Texts.bounded(f.getFile().getPath(), Texts.MAX_DISPLAY),
          f.getPosition().map(p -> (long) p.getLine()).orElse(null),
          null);
    }
    if (source instanceof ClasspathResourceSource r) {
      return new Location(
          Texts.bounded(r.getClasspathResourceName(), Texts.MAX_DISPLAY),
          r.getPosition().map(p -> (long) p.getLine()).orElse(null),
          null);
    }
    return null;
  }

  static Status status(TestExecutionResult.Status status) {
    return switch (status) {
      case SUCCESSFUL -> Status.PASSED;
      case FAILED -> Status.FAILED;
      case ABORTED -> Status.SKIPPED;
    };
  }

  static List<Failure> failures(@Nullable Throwable throwable) {
    if (throwable == null) {
      return List.of();
    }
    return List.of(failure(throwable, PhaseInference.infer(throwable)));
  }

  static Failure failure(Throwable throwable, @Nullable FailurePhase phase) {
    String message = throwable.getMessage();
    return new Failure(
        Texts.bounded(
            message == null || message.isBlank() ? throwable.getClass().getName() : message,
            Texts.MAX_MESSAGE),
        Texts.bounded(throwable.getClass().getName(), 512),
        Texts.stackTrace(throwable),
        phase,
        null);
  }
}
