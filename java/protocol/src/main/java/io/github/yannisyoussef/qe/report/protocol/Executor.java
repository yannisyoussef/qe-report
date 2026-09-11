package io.github.yannisyoussef.qe.report.protocol;

import org.jspecify.annotations.Nullable;

/** The CI or local context that ran the session. All fields optional. */
public record Executor(
    @Nullable String name, @Nullable String buildId, @Nullable String buildUrl) {}
