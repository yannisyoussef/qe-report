package io.github.yannisyoussef.qe.report.protocol;

import org.jspecify.annotations.Nullable;

/** Version control state of the tested code. All fields optional. */
public record Source(
    @Nullable String repository, @Nullable String revision, @Nullable String branch) {}
