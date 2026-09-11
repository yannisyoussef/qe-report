// A consumer of the qe-report JUnit Platform adapter, resolved as a published artifact from the
// build-local repository. Exists only to prove ServiceLoader discovery and forked execution.
rootProject.name = "qe-report-gradle-consumer"

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven { url = uri(providers.gradleProperty("qe.localRepo").get()) }
        mavenCentral()
    }
}
