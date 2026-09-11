package io.github.yannisyoussef.qe.report.junitplatform.internal;

import io.github.yannisyoussef.qe.report.protocol.HistoricalIdStability;
import java.util.List;
import java.util.Optional;
import org.jspecify.annotations.Nullable;
import org.junit.platform.engine.TestSource;
import org.junit.platform.engine.UniqueId;
import org.junit.platform.engine.support.descriptor.ClassSource;
import org.junit.platform.engine.support.descriptor.ClasspathResourceSource;
import org.junit.platform.engine.support.descriptor.FileSource;
import org.junit.platform.engine.support.descriptor.MethodSource;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;

/**
 * Historical identity of a JUnit Platform test, always prefixed by the engine id so that two
 * engines in one plan cannot collide. Rules, in order:
 *
 * <ol>
 *   <li>Any {@code dynamic-test} or {@code dynamic-container} segment: no identity ({@code
 *       unavailable}). JUnit names these by registration order only.
 *   <li>A {@code test-template-invocation} (parameterized, repeated): the template method's {@code
 *       MethodSource} plus the invocation segment, {@code uncertain}, because the segment is an
 *       index.
 *   <li>A {@code MethodSource}: {@code engine:class#method(parameterTypes)}, {@code stable}.
 *   <li>A {@code ClassSource}: {@code engine:class}, {@code stable}.
 *   <li>A file or classpath resource source: the resource plus its line when present, {@code
 *       uncertain}, because a line moves with unrelated edits.
 *   <li>Otherwise the unique id without its engine segment, {@code uncertain}.
 * </ol>
 */
final class HistoricalIdentity {
  record Derived(@Nullable String id, HistoricalIdStability stability) {}

  private static final Derived UNAVAILABLE = new Derived(null, HistoricalIdStability.UNAVAILABLE);

  private HistoricalIdentity() {}

  static Derived derive(TestPlan plan, TestIdentifier identifier) {
    UniqueId uid = identifier.getUniqueIdObject();
    List<UniqueId.Segment> segments = uid.getSegments();
    String engine = segments.isEmpty() ? "unknown" : segments.get(0).getValue();
    for (UniqueId.Segment s : segments) {
      if (s.getType().startsWith("dynamic-")) {
        return UNAVAILABLE;
      }
    }
    UniqueId.Segment last = segments.get(segments.size() - 1);
    if (last.getType().equals("test-template-invocation")) {
      Optional<TestIdentifier> parent = plan.getParent(identifier);
      String base =
          parent.flatMap(TestIdentifier::getSource).map(HistoricalIdentity::sourceId).orElse(null);
      if (base == null) {
        base = withoutEngine(uid.removeLastSegment());
      }
      return new Derived(
          engine + ":" + base + "[" + last.getValue() + "]", HistoricalIdStability.UNCERTAIN);
    }
    Optional<TestSource> source = identifier.getSource();
    if (source.isPresent()) {
      TestSource s = source.get();
      if (s instanceof MethodSource || s instanceof ClassSource) {
        return new Derived(engine + ":" + sourceId(s), HistoricalIdStability.STABLE);
      }
      String positional = positionalId(s);
      if (positional != null) {
        return new Derived(engine + ":" + positional, HistoricalIdStability.UNCERTAIN);
      }
    }
    return new Derived(engine + ":" + withoutEngine(uid), HistoricalIdStability.UNCERTAIN);
  }

  private static @Nullable String sourceId(TestSource s) {
    if (s instanceof MethodSource m) {
      return m.getClassName() + "#" + m.getMethodName() + "(" + m.getMethodParameterTypes() + ")";
    }
    if (s instanceof ClassSource c) {
      return c.getClassName();
    }
    return null;
  }

  private static @Nullable String positionalId(TestSource s) {
    if (s instanceof FileSource f) {
      return f.getFile().getPath() + f.getPosition().map(p -> ":" + p.getLine()).orElse("");
    }
    if (s instanceof ClasspathResourceSource r) {
      return r.getClasspathResourceName() + r.getPosition().map(p -> ":" + p.getLine()).orElse("");
    }
    return null;
  }

  private static String withoutEngine(UniqueId uid) {
    List<UniqueId.Segment> segments = uid.getSegments();
    StringBuilder sb = new StringBuilder();
    for (int i = 1; i < segments.size(); i++) {
      if (sb.length() > 0) {
        sb.append('/');
      }
      sb.append('[')
          .append(segments.get(i).getType())
          .append(':')
          .append(segments.get(i).getValue())
          .append(']');
    }
    return sb.toString();
  }
}
