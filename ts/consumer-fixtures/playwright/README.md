# Playwright consumer fixture

A Playwright Test project that consumes the qe-report reporter as a package, registered by
name in its configuration the way a real project would. The reporter's consumer tests run it
through real `playwright test` invocations (retries, `repeatEach`, projects, shards, hook
failures, attachments, and the runner-level cases under `tests/global`) and validate every
run directory with the protocol validator. It is a workspace member for resolution only and
is not part of the build.
