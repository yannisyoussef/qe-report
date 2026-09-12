plugins {
    `java-test-fixtures`
}

description = "qe-report protocol model and JSON codec (compatibility line 0.3)"

dependencies {
    implementation(platform(libs.jackson.bom))
    implementation(libs.jackson.databind)
    testFixturesImplementation(platform(libs.jackson.bom))
    testFixturesImplementation(libs.jackson.databind)
    testFixturesImplementation(libs.json.schema.validator)
    testImplementation(libs.json.schema.validator)
}
