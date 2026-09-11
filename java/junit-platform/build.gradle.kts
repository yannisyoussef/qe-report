import net.ltgt.gradle.errorprone.errorprone

description = "qe-report adapter for the JUnit Platform: a TestExecutionListener discovered through ServiceLoader"

dependencies {
    api(project(":sdk"))
    // The consumer's test runtime provides the launcher; the adapter compiles against the lowest
    // supported line so that it uses no newer API by accident.
    compileOnly(libs.junit.platform.launcher.min)

    testImplementation(testFixtures(project(":protocol")))
    testImplementation(libs.json.schema.validator)
    testImplementation("org.junit.jupiter:junit-jupiter-params")
    testImplementation("org.junit.platform:junit-platform-launcher")
    testImplementation("org.junit.platform:junit-platform-suite-engine")
    testImplementation("org.junit.vintage:junit-vintage-engine")
    testImplementation("junit:junit:4.13.2")
}

// Test suites the adapter is exercised against. They live in their own source set so that the
// module's own test task never discovers them as tests.
val fixtures: SourceSet by sourceSets.creating
dependencies {
    "fixturesImplementation"(platform(libs.junit.bom))
    "fixturesImplementation"("org.junit.jupiter:junit-jupiter")
    "fixturesImplementation"("junit:junit:4.13.2")
    testImplementation(fixtures.output)
}

tasks.processResources {
    val adapterVersion = project.version.toString()
    inputs.property("adapterVersion", adapterVersion)
    filesMatching("**/adapter.properties") { expand("version" to adapterVersion) }
}

tasks.withType<Test>().configureEach {
    // This module's own tests run under a launcher that would auto-register the adapter itself.
    systemProperty("qe.report.enabled", "false")
    systemProperty("qe.fixturesClasses", fixtures.output.classesDirs.asPath)
    systemProperty("qe.consumerFixtures", projectDir.resolve("../consumer-fixtures").canonicalPath)
    systemProperty(
        "qe.consumerRuns",
        layout.buildDirectory
            .dir("consumer-runs")
            .get()
            .asFile.path,
    )
    systemProperty("qe.gradleWrapper", rootProject.projectDir.resolve("gradlew").canonicalPath)
    systemProperty(
        "qe.localRepo",
        rootProject.layout.buildDirectory
            .dir("local-repo")
            .get()
            .asFile.path,
    )
    systemProperty("qe.adapterVersion", project.version.toString())
}

// The consumer fixtures (Gradle and Maven Surefire) resolve the adapter from the build-local
// repository and run only in the default test task.
tasks.test {
    dependsOn(":publishToBuildLocal")
    useJUnitPlatform()
}

// JUnit Platform compatibility matrix: the adapter's launcher tests against the proposed minimum,
// the last 1.x line, and the current 6.x lines, each substituting every org.junit artifact.
data class JUnitLine(
    val name: String,
    val platform: String,
    val jupiter: String,
    val jdk: Int,
)
val junitLines =
    listOf(
        JUnitLine("110", "1.10.5", "5.10.5", 17),
        JUnitLine("113", "1.13.4", "5.13.4", 21),
        JUnitLine("60", "6.0.3", "6.0.3", 25),
    )
val toolchains = the<JavaToolchainService>()
val requestedJdks =
    (findProperty("testJavaVersions") as String?)?.split(",")?.map { it.trim().toInt() } ?: emptyList()
junitLines.forEach { line ->
    val runtime =
        configurations.create("junit${line.name}TestRuntime") {
            extendsFrom(configurations.testRuntimeClasspath.get())
            resolutionStrategy.eachDependency {
                if (requested.group == "org.junit.platform") useVersion(line.platform)
                if (requested.group == "org.junit.jupiter" || requested.group == "org.junit.vintage") useVersion(line.jupiter)
                if (requested.group == "org.junit" && requested.name == "junit-bom") useVersion(line.jupiter)
            }
        }
    val task =
        tasks.register<Test>("testOnJUnit${line.name}") {
            description = "Adapter launcher tests on JUnit Platform ${line.platform} (Jupiter ${line.jupiter})"
            group = "verification"
            testClassesDirs =
                sourceSets.test
                    .get()
                    .output.classesDirs
            classpath = sourceSets.test.get().output + sourceSets.main.get().output + fixtures.output + runtime
            useJUnitPlatform { excludeTags("consumer") }
            // The JDK for this line is only honoured when the build was asked for that JDK matrix.
            if (line.jdk in requestedJdks) {
                javaLauncher.set(toolchains.launcherFor { languageVersion.set(JavaLanguageVersion.of(line.jdk)) })
            }
        }
    tasks.named("check") { dependsOn(task) }
}

// The fixture suites deliberately throw from hooks and tests; static analysis meant for library
// code does not apply to them.
tasks.named<JavaCompile>("compileFixturesJava") {
    options.errorprone.enabled.set(false)
    options.compilerArgs.remove("-Werror")
}
