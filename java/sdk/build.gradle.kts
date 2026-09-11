description = "qe-report producer SDK: session writer, file sink, redaction"

dependencies {
    api(project(":protocol"))
    implementation(platform(libs.jackson.bom))
    implementation(libs.jackson.databind)
    testImplementation(testFixtures(project(":protocol")))
    testImplementation(libs.json.schema.validator)
}

// Produces the Java reference output that the cross-language equivalence check compares with the
// TypeScript output. Test-only; see ts/packages/equivalence.
val equivalenceOutput by tasks.registering(JavaExec::class) {
    description = "Writes the Java equivalence reference output to build/equivalence"
    group = "verification"
    classpath = sourceSets.test.get().runtimeClasspath
    mainClass.set("io.github.yannisyoussef.qe.report.sdk.EquivalenceHarness")
    val out = layout.buildDirectory.dir("equivalence")
    outputs.dir(out)
    args(out.get().asFile.path, rootProject.projectDir.resolve("../protocol/fixtures").canonicalPath)
}
