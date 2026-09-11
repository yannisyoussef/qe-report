plugins {
    java
}

dependencies {
    testImplementation(platform("org.junit:junit-bom:6.1.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    // The adapter on the test runtime classpath is all a consumer adds.
    testRuntimeOnly("io.github.yannisyoussef:qe-report-junit-platform:0.1.0")
}

tasks.test {
    useJUnitPlatform()
    ignoreFailures = true
    // Three JVMs, two classes each, running their tests in parallel threads.
    maxParallelForks = 3
    setForkEvery(2)
    systemProperty("junit.jupiter.execution.parallel.enabled", "true")
    systemProperty("junit.jupiter.execution.parallel.mode.default", "concurrent")
    systemProperty("qe.report.dir", providers.gradleProperty("qe.report.dir").get())
    systemProperty("qe.report.runId", providers.gradleProperty("qe.report.runId").get())
    testLogging { events("failed") }
}
