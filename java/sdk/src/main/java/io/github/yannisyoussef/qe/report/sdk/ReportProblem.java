package io.github.yannisyoussef.qe.report.sdk;

import org.jspecify.annotations.Nullable;

/**
 * Something the SDK could not do. Reporting problems never change a test result and never propagate
 * into the test; they are delivered to a {@link ReportProblemHandler}.
 */
public record ReportProblem(Kind kind, String message, @Nullable Throwable cause) {

  public enum Kind {
    /** The serialised event exceeds the size limit and was dropped. */
    EVENT_TOO_LARGE,
    /** The attachment exceeds the size limit and was not stored. */
    ATTACHMENT_TOO_LARGE,
    /** The sink failed to write; the event or attachment is lost. */
    SINK_FAILURE,
    /** A session-scoped event was emitted after session.finished and was dropped. */
    SESSION_FINISHED,
    /** An event was emitted after run.finished and was dropped. */
    RUN_FINISHED,
    /**
     * A supplied session outcome could not be written, even reduced to its status alone (too large,
     * or the sink failed): no session.finished was emitted, the session stays structurally open,
     * and it accepts nothing further. Also reported for anything emitted after that.
     */
    TERMINAL_OUTCOME_NOT_WRITTEN
  }
}
