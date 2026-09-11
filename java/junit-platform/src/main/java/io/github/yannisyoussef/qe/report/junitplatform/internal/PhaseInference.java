package io.github.yannisyoussef.qe.report.junitplatform.internal;

import io.github.yannisyoussef.qe.report.protocol.FailurePhase;
import java.lang.annotation.Annotation;
import java.lang.reflect.Method;
import java.util.Map;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * Where a failure originated, read from the throw site rather than from the exception class.
 *
 * <p>JUnit prunes its own frames from a reported throwable, so the top frames belong to user code.
 * The first frame whose method carries a Jupiter lifecycle or test annotation, or whose class is a
 * Jupiter lifecycle extension, decides the phase. Nothing is inferred when no such frame is found.
 * Only annotation and interface names are compared, so the adapter needs no Jupiter dependency.
 */
final class PhaseInference {
  private static final Map<String, FailurePhase> METHOD_ANNOTATIONS =
      Map.of(
          "org.junit.jupiter.api.BeforeEach", FailurePhase.SETUP,
          "org.junit.jupiter.api.BeforeAll", FailurePhase.SETUP,
          "org.junit.jupiter.api.AfterEach", FailurePhase.TEARDOWN,
          "org.junit.jupiter.api.AfterAll", FailurePhase.TEARDOWN,
          "org.junit.jupiter.api.Test", FailurePhase.TEST,
          "org.junit.jupiter.api.TestTemplate", FailurePhase.TEST,
          "org.junit.jupiter.api.TestFactory", FailurePhase.TEST,
          "org.junit.jupiter.api.RepeatedTest", FailurePhase.TEST,
          "org.junit.jupiter.params.ParameterizedTest", FailurePhase.TEST);
  private static final Map<String, FailurePhase> EXTENSION_INTERFACES =
      Map.of(
          "org.junit.jupiter.api.extension.BeforeEachCallback", FailurePhase.SETUP,
          "org.junit.jupiter.api.extension.BeforeAllCallback", FailurePhase.SETUP,
          "org.junit.jupiter.api.extension.BeforeTestExecutionCallback", FailurePhase.SETUP,
          "org.junit.jupiter.api.extension.AfterEachCallback", FailurePhase.TEARDOWN,
          "org.junit.jupiter.api.extension.AfterAllCallback", FailurePhase.TEARDOWN,
          "org.junit.jupiter.api.extension.AfterTestExecutionCallback", FailurePhase.TEARDOWN);
  private static final Set<String> EXTENSION_METHODS =
      Set.of(
          "beforeEach",
          "beforeAll",
          "beforeTestExecution",
          "afterEach",
          "afterAll",
          "afterTestExecution");
  private static final int MAX_FRAMES = 40;

  private PhaseInference() {}

  static @Nullable FailurePhase infer(Throwable throwable) {
    StackTraceElement[] frames = throwable.getStackTrace();
    for (int i = 0; i < Math.min(frames.length, MAX_FRAMES); i++) {
      FailurePhase phase = phaseOf(frames[i]);
      if (phase != null) {
        return phase;
      }
    }
    return null;
  }

  private static @Nullable FailurePhase phaseOf(StackTraceElement frame) {
    Class<?> type;
    try {
      type = Class.forName(frame.getClassName(), false, contextLoader());
    } catch (ClassNotFoundException | LinkageError | SecurityException e) {
      return null;
    }
    if (EXTENSION_METHODS.contains(frame.getMethodName())) {
      for (Class<?> c = type; c != null; c = c.getSuperclass()) {
        for (Class<?> i : c.getInterfaces()) {
          FailurePhase p = EXTENSION_INTERFACES.get(i.getName());
          if (p != null && frame.getMethodName().equals(callbackMethod(i.getName()))) {
            return p;
          }
        }
      }
    }
    for (Method m : declaredMethods(type)) {
      if (!m.getName().equals(frame.getMethodName())) {
        continue;
      }
      for (Annotation a : m.getAnnotations()) {
        FailurePhase p = METHOD_ANNOTATIONS.get(a.annotationType().getName());
        if (p != null) {
          return p;
        }
        for (Annotation meta : a.annotationType().getAnnotations()) {
          FailurePhase mp = METHOD_ANNOTATIONS.get(meta.annotationType().getName());
          if (mp != null) {
            return mp;
          }
        }
      }
    }
    return null;
  }

  private static String callbackMethod(String interfaceName) {
    String simple = interfaceName.substring(interfaceName.lastIndexOf('.') + 1);
    String base = simple.substring(0, simple.length() - "Callback".length());
    return Character.toLowerCase(base.charAt(0)) + base.substring(1);
  }

  private static Method[] declaredMethods(Class<?> type) {
    try {
      return type.getDeclaredMethods();
    } catch (LinkageError | SecurityException e) {
      return new Method[0];
    }
  }

  private static ClassLoader contextLoader() {
    ClassLoader cl = Thread.currentThread().getContextClassLoader();
    return cl != null ? cl : PhaseInference.class.getClassLoader();
  }
}
