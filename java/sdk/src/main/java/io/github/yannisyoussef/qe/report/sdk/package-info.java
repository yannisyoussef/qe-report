/**
 * Producer-side SDK for the qe-report protocol: a session writer that fills the event envelope, a
 * file sink, and the redaction boundary applied before anything is serialised.
 *
 * <p>Nothing here throws into the test that is being reported. Problems are delivered to a {@link
 * io.github.yannisyoussef.qe.report.sdk.ReportProblemHandler}.
 */
@NullMarked
package io.github.yannisyoussef.qe.report.sdk;

import org.jspecify.annotations.NullMarked;
