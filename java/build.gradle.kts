import net.ltgt.gradle.errorprone.errorprone

plugins {
    alias(libs.plugins.errorprone) apply false
    alias(libs.plugins.spotless) apply false
}

// The release contract is the single source of the product version; this build does not carry one
// of its own. release/verify-contract.mjs fails if a literal reappears here, and Gradle treats the
// file as a configuration input, so changing it reconfigures the build.
@Suppress("UNCHECKED_CAST")
val releaseContract =
    groovy.json.JsonSlurper().parse(rootProject.file("../release/release.json")) as Map<String, Any>
val productVersion = releaseContract["productVersion"] as String
val mavenContract = releaseContract["maven"] as Map<String, Any>
val publicMavenArtifacts = (mavenContract["public"] as List<*>).map { it as String }
val repositoryContract = releaseContract["repository"] as Map<String, Any>
val projectUrl = repositoryContract["url"] as String

allprojects {
    group = mavenContract["groupId"] as String
    version = productVersion
}

subprojects {
    apply(plugin = "java-library")
    apply(plugin = "maven-publish")
    apply(plugin = "net.ltgt.errorprone")
    apply(plugin = "com.diffplug.spotless")

    // Artifact coordinates follow the ecosystem naming rules (qe-report-<module>). The only
    // repositories configured are local directories: one the consumer fixtures resolve from, and
    // one the release bundle is assembled from. Nothing here publishes over the network, and no
    // remote repository is configured even in the release path, which uploads a validated bundle.
    extensions.configure<PublishingExtension> {
        publications {
            create<MavenPublication>("maven") {
                from(components["java"])
                artifactId = "qe-report-${project.name}"

                // Test fixtures are a convenience for this build's own tests, resolved between
                // projects. They are not a public API, they carry no compatibility promise, and a
                // release bundle holds only intended release material, so the variant is skipped
                // rather than published as a jar nobody should be depending on.
                afterEvaluate {
                    val javaComponent = components["java"] as AdhocComponentWithVariants
                    listOf("testFixturesApiElements", "testFixturesRuntimeElements").forEach { name ->
                        configurations.findByName(name)?.let {
                            javaComponent.withVariantsFromConfiguration(it) { skip() }
                        }
                    }
                }

                // What Maven Central requires of a POM, from the repository's own facts. Nothing
                // invented: the developer is the sole author of every commit here.
                pom {
                    name.set("qe-report-${project.name}")
                    description.set(
                        when (project.name) {
                            "protocol" ->
                                "qe-report protocol model and JSON codec (compatibility line " +
                                    "${(releaseContract["compatibility"] as Map<*, *>)["protocolCompatibility"]})"
                            "sdk" ->
                                "qe-report session writer, file sink and redaction for Java producers"
                            "junit-platform" ->
                                "qe-report adapter for the JUnit Platform, discovered through ServiceLoader"
                            else -> "qe-report ${project.name}"
                        },
                    )
                    url.set(projectUrl)
                    licenses {
                        license {
                            name.set("Apache License, Version 2.0")
                            url.set("https://www.apache.org/licenses/LICENSE-2.0.txt")
                            distribution.set("repo")
                        }
                    }
                    developers {
                        developer {
                            id.set("yannisyoussef")
                            name.set("Yannis BA BINENI")
                            url.set("https://github.com/yannisyoussef")
                        }
                    }
                    scm {
                        connection.set("scm:git:$projectUrl.git")
                        developerConnection.set("scm:git:ssh://github.com/yannisyoussef/qe-report.git")
                        url.set(projectUrl)
                    }
                    issueManagement {
                        system.set("GitHub Issues")
                        url.set("$projectUrl/issues")
                    }
                }
            }
        }
        repositories {
            maven {
                name = "buildLocal"
                url = uri(rootProject.layout.buildDirectory.dir("local-repo"))
            }
            // Where the Central bundle is assembled from. Still a directory on this machine: the
            // release uploads a bundle that has been validated first, rather than streaming
            // artifacts to a registry as a side effect of building them.
            maven {
                name = "releaseStaging"
                url = uri(rootProject.layout.buildDirectory.dir("release-staging"))
            }
        }
    }

    // Central requires both, and a consumer reading an unfamiliar API deserves them anyway.
    extensions.configure<JavaPluginExtension> {
        toolchain { languageVersion.set(JavaLanguageVersion.of(25)) }
        withSourcesJar()
        withJavadocJar()
    }

    // The same source at the same tag should produce the same bytes. Gradle otherwise records the
    // build time and the filesystem's own directory order in every archive.
    tasks.withType<AbstractArchiveTask>().configureEach {
        isPreserveFileTimestamps = false
        isReproducibleFileOrder = true
        dirPermissions { unix("rwxr-xr-x") }
        filePermissions { unix("rw-r--r--") }
    }

    // Signing, for Central. The key never comes from the repository: it arrives as an in-memory
    // ASCII-armoured value from the release environment, or, in a rehearsal, from an ephemeral key
    // generated for that run alone. With no key present the build simply does not sign, so an
    // ordinary developer build needs no GPG setup at all.
    apply(plugin = "signing")
    val signingKey = providers.environmentVariable("QE_REPORT_SIGNING_KEY").orNull
    val signingPassword = providers.environmentVariable("QE_REPORT_SIGNING_PASSWORD").orNull
    extensions.configure<SigningExtension> {
        isRequired = signingKey != null
        if (signingKey != null) {
            useInMemoryPgpKeys(signingKey, signingPassword ?: "")
            sign(extensions.getByType<PublishingExtension>().publications["maven"])
        }
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

tasks.register("publishToReleaseStaging") {
    description = "Publishes every module to build/release-staging, the source of the Central bundle"
    group = "publishing"
    dependsOn(subprojects.map { "${it.path}:publishMavenPublicationToReleaseStagingRepository" })
}

// The publication boundary, in the build that owns it: every module here is published, and the
// release contract names exactly these three. A module added without deciding whether it is public
// fails the build rather than appearing in a bundle.
tasks.register("verifyPublicationBoundary") {
    description = "Checks the published modules against release/release.json"
    group = "verification"
    val published = subprojects.map { "qe-report-${it.name}" }.sorted()
    val declared = publicMavenArtifacts.sorted()
    doLast {
        require(published == declared) {
            "the release contract names $declared as public Maven artifacts, but this build " +
                "publishes $published"
        }
    }
}

// The root project has no `check` of its own, so every module's does.
subprojects { tasks.named("check") { dependsOn(rootProject.tasks.named("verifyPublicationBoundary")) } }

// What a Java consumer of this release actually gets on its runtime classpath, written where the
// release SBOM can read it. Registered per module and resolving only that module's own
// configuration: the configuration cache forbids one project resolving another's, and reading the
// answer out of a text report instead would mean parsing Gradle's output rather than asking it.
subprojects {
    tasks.register("releaseDependencies") {
        description = "Writes this module's resolved runtime dependencies for the release SBOM"
        group = "publishing"
        val output = layout.buildDirectory.file("release-dependencies.txt")
        val artifactId = "qe-report-${project.name}"
        val coordinates =
            configurations.named("runtimeClasspath").map { configuration ->
                configuration.incoming.resolutionResult.allComponents
                    .map { it.id.displayName }
                    .filterNot { it.startsWith("project ") }
                    .sorted()
            }
        outputs.file(output)
        doLast {
            output.get().asFile.writeText(
                coordinates.get().joinToString("\n", postfix = "\n") { "$artifactId\t$it" },
            )
        }
    }
}

tasks.register("releaseDependencies") {
    description = "Writes every published module's resolved runtime dependencies"
    group = "publishing"
    dependsOn(subprojects.map { "${it.path}:releaseDependencies" })
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
