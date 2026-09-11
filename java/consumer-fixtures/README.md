# Consumer fixtures

Small Gradle and Maven Surefire projects that consume the JUnit Platform adapter as a published
artifact from `../build/local-repo`. They are executed by the adapter's acceptance tests to prove
that ServiceLoader discovery and forked, parallel execution work in real builds. They are not
part of this repository's own build.
