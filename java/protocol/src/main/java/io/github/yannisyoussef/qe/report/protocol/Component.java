package io.github.yannisyoussef.qe.report.protocol;

import java.util.Objects;
import org.jspecify.annotations.Nullable;

/** A named, versioned piece of software: the producing adapter or the observed runner. */
public record Component(String name, @Nullable String version) {
  public Component {
    Objects.requireNonNull(name, "name");
  }
}
