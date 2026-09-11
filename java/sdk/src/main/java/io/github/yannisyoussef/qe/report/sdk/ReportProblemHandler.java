package io.github.yannisyoussef.qe.report.sdk;

/** Receives problems the SDK could not resolve itself. Implementations must not throw. */
@FunctionalInterface
public interface ReportProblemHandler {
  void onProblem(ReportProblem problem);

  /** Prints each problem once to standard error. */
  static ReportProblemHandler standardError() {
    return problem -> {
      System.err.println("qe-report: " + problem.kind() + ": " + problem.message());
      if (problem.cause() != null) {
        System.err.println("qe-report:   cause: " + problem.cause());
      }
    };
  }
}
