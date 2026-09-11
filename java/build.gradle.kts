import net.ltgt.gradle.errorprone.errorprone

plugins {
    alias(libs.plugins.errorprone) apply false
    alias(libs.plugins.spotless) apply false
}

allprojects {
    group = "io.github.yannisyoussef"
    version = "0.1.0"
}

subprojects {
    apply(plugin = "java-library")
    apply(plugin = "maven-publish")
    apply(plugin = "net.ltgt.errorprone")
    apply(plugin = "com.diffplug.spotless")

    // Artifact coordinates follow the ecosystem naming rules (qe-report-<module>). The only
    // repository configured is a build-local directory that the consumer fixtures resolve from;
    // nothing is published anywhere else.
    extensions.configure<PublishingExtension> {
        publications {
            create<MavenPublication>("maven") {
                from(components["java"])
                artifactId = "qe-report-${project.name}"
            }
        }
        repositories {
            maven {
                name = "buildLocal"
                url = uri(rootProject.layout.buildDirectory.dir("local-repo"))
            }
        }
    }

    extensions.configure<JavaPluginExtension> {
        toolchain { languageVersion.set(JavaLanguageVersion.of(25)) }
    }

    dependencies {
        "api"(rootProject.libs.jspecify)
        "errorprone"(rootProject.libs.errorprone.core)
        "testImplementation"(platform(rootProject.libs.junit.bom))
        "testImplementation"(rootProject.libs.junit.jupiter)
        "testRuntimeOnly"(rootProject.libs.junit.platform.launcher)
    }

    tasks.withType<JavaCompile>().configureEach {
        // Published artifacts target Java 17 bytecode and APIs; the build runs on the Java 25 toolchain.
        options.release.set(17)
        options.encoding = "UTF-8"
        options.compilerArgs.addAll(listOf("-Xlint:all", "-Werror"))
        options.errorprone.disableWarningsInGeneratedCode.set(true)
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        systemProperty("qe.protocolDir", rootProject.projectDir.resolve("../protocol").canonicalPath)
        testLogging { events("failed", "skipped") }
    }

    tasks.withType<Javadoc>().configureEach {
        (options as StandardJavadocDocletOptions).addBooleanOption("Xdoclint:all,-missing", true)
    }

    extensions.configure<com.diffplug.gradle.spotless.SpotlessExtension> {
        java {
            googleJavaFormat(rootProject.libs.versions.google.java.format.get())
            removeUnusedImports()
        }
        kotlinGradle { ktlint() }
    }
}

tasks.register("publishToBuildLocal") {
    description = "Publishes every module to build/local-repo for the consumer fixtures"
    group = "verification"
    dependsOn(subprojects.map { "${it.path}:publishMavenPublicationToBuildLocalRepository" })
}

// Published libraries target Java 17 bytecode. With -PtestJavaVersions=17,21 the test suites also
// run on those runtimes (toolchains are provisioned by the foojay resolver); CI always passes it.
val extraTestJavaVersions =
    (findProperty("testJavaVersions") as String?)
        ?.split(",")
        ?.map { it.trim().toInt() }
        ?.filter { it != 25 }
        ?: emptyList()

subprojects {
    val projectSourceSets = the<SourceSetContainer>()
    val toolchains = the<JavaToolchainService>()
    val protocolDir = rootProject.projectDir.resolve("../protocol").canonicalPath
    extraTestJavaVersions.forEach { version ->
        val task =
            tasks.register<Test>("testOn$version") {
                description = "Runs the test suite on a Java $version runtime"
                group = "verification"
                testClassesDirs = projectSourceSets["test"].output.classesDirs
                classpath = projectSourceSets["test"].runtimeClasspath
                javaLauncher.set(
                    toolchains.launcherFor { languageVersion.set(JavaLanguageVersion.of(version)) },
                )
                // Consumer fixtures spawn whole builds; they run once, in the default test task.
                useJUnitPlatform { excludeTags("consumer") }
                systemProperty("qe.protocolDir", protocolDir)
            }
        tasks.named("check") { dependsOn(task) }
    }
}
