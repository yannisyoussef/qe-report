plugins {
    `java-test-fixtures`
}

description = "qe-report protocol model and JSON codec (compatibility line 0.2)"

dependencies {
    implementation(platform(libs.jackson.bom))
    implementation(libs.jackson.databind)
    testFixturesImplementation(platform(libs.jackson.bom))
    testFixturesImplementation(libs.jackson.databind)
    testImplementation(libs.json.schema.validator)
}
