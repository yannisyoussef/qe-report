# Releasing qe-report

This describes how a release is made, what has to be true before one can be, and what cannot be
undone afterwards. Read the last section first if you are about to publish something.

The release contract is `release/release.json`. It names the product version, the compatibility
lines, the public packages and the container. CI checks it against the code, so it is the one place
a version is decided.

## What state this is in

Two halves of readiness, deliberately separated:

```
release software readiness   VERIFIED by CI
registry/account readiness   OWNER PRECONDITIONS
actual publication           NOT PERFORMED
```

Everything a repository can prove about a release is proven by CI on every pull request: the
packages pack, their tarballs contain only what they should, clean consumers install and use them
outside the workspace, the Maven bundle is assembled and its signatures verify with an ephemeral
key, the container builds and reports its version, and the manifest, SBOMs and checksums generate.
None of that touches a registry.

What a repository cannot prove is account state. The checklist below is the owner's, and no part of
it can be satisfied by code in this repository. Until it is complete, no release can be made — and
the release workflow is built to fail rather than to skip a registry it cannot reach.

## External release preconditions

**Maven Central**

- [ ] `io.github.yannisyoussef` namespace verified in the Central Publisher Portal
- [ ] Central publishing token configured in the protected GitHub `release` environment
- [ ] PGP signing key and passphrase configured in the protected GitHub `release` environment

**npm**

- [x] five public package names verified available
- [ ] first-publication authentication configured
- [ ] trusted publishing / OIDC configured where npm permits it
- [ ] bootstrap credential removed once trusted publishing is established

**GitHub**

- [ ] protected `release` environment configured
- [ ] owner approval required for irreversible publication jobs
- [ ] GHCR package visibility and settings confirmed

The one ticked box was checked against the real registry: at the time of writing, all five names
return 404 from `registry.npmjs.org`, so none is owned by an unrelated publisher. That check is part
of the release workflow too, and it fails the release if a name has been taken since.

### On the two that need an account

Namespace ownership on Central cannot be asserted from here. `io.github.yannisyoussef` is the
intended namespace and matches the GitHub account, which is the form Central verifies through a
GitHub-based ownership check, but whether the namespace is verified is a fact about the Portal
account and has to be read there. Nothing in this repository claims it is.

npm's steady state is trusted publishing, where the workflow authenticates through OIDC and no
long-lived token exists. A package that does not exist yet may need one publication before a trusted
publisher can be attached to it; if npm's current rules allow establishing it first, do that
instead. Either way the credential lives in the protected `release` environment, is scoped as
narrowly as npm allows, and is removed once trusted publishing is in place. Check npm's own
documentation at the time of the release rather than trusting this paragraph.

## Prerequisites on the machine

Nothing, for a release. The release runs in GitHub Actions on hosted runners, from a tag. Local
tooling matters only for the rehearsal: Node 22 or newer, a JDK, Docker, and GPG if you want the
signature checks to run rather than be reported as not exercised.

## Rehearsing, without publishing anything

```sh
cd ts && pnpm release:verify
```

This does everything a release does except contact a registry: verifies the contract, builds both
languages, packs the npm tarballs and audits them, installs them into a clean directory and uses
them, stages the Maven artifacts, signs them with an ephemeral key, validates and assembles the
Central bundle, runs the clean Gradle and Maven consumers on Java 17, builds the container and
checks what it reports, generates the SBOMs, the release manifest and the checksums, and scans every
artifact for build paths and secrets. It exits non-zero on any failure.

It cannot publish. There is no registry credential in it, no push, and no tag.

## The promotion model

```
QE-012 merged into develop
        ↓
release PR: develop -> master
        ↓
full CI green
        ↓
merge to master            (an explicit owner action, never automated)
        ↓
verify master
        ↓
create v1.0.0 on the master release commit
        ↓
release workflow
```

`develop` is integration and `master` is the released line. There is no permanent release branch.
Promotion is a pull request a person merges; nothing automates it.

## Making a release

1. Confirm the preconditions above are all ticked.
2. Open a pull request from `develop` to `master`. Let CI finish green.
3. Merge it. Note the commit on `master`.
4. Verify that commit is what you intend to release.
5. Tag it: `git tag v1.0.0 <commit> && git push origin v1.0.0`. The tag must equal
   `v` followed by `productVersion` from the release contract, and the workflow refuses anything
   else.
6. Approve the `release` environment when the workflow asks. That approval is the last reversible
   moment.
7. Watch the workflow. It publishes npm, then Maven Central, then GHCR, verifies each, and only then
   creates the GitHub Release.

## What the workflow checks before it publishes

- the tag matches the product version in the contract;
- the tagged commit is an ancestor of `master` and is `master`'s own release commit, so nothing can
  be published from `develop`, a feature branch, or an unreviewed commit;
- every artifact is built from that one commit;
- the whole rehearsal passes;
- every credential it needs is present. A missing credential fails the job. It never skips a
  registry and reports success.

## Publication is not atomic

Three registries cannot be committed as one transaction. If the workflow publishes some and fails
on another:

- do not delete or move the tag;
- do not change the source under the same version;
- do not republish a version a registry has already accepted;
- fix the cause, and re-run the workflow from the same tag.

A re-run checks what already exists. For npm it compares the registry's integrity for
`package@version` with the tarball it just built: identical means already done, different is a hard
failure. For Central it reads the deployment state. For GHCR it compares digests. It continues with
what is missing and creates no second GitHub Release.

## Versions are immutable

Once any registry has accepted `1.0.0`, that version is what `1.0.0` means, forever. A defect found
afterwards is fixed in `1.0.1`.

"Rollback" does not exist for npm or Maven Central. What exists is:

- stop recommending the bad version;
- publish a corrected one;
- deprecate the bad npm version if that helps consumers;
- say what happened, in release notes or a security advisory.

A container consumer can go back to an earlier immutable digest, and should pin digests in
production. An exact SemVer image tag is never overwritten with different bytes. The moving aliases,
`1.0` and `1`, advance to the newest matching release and nothing else. `latest` is not published in
the initial v1 release.

## Verifying a release afterwards

```sh
node release/verify-published.mjs 1.0.0
```

Read-only, no credentials, public endpoints only. It checks that the five npm packages exist at that
version with provenance, that the three Maven artifacts and their signatures are on Central, that the
container's version tag and its `1.0` and `1` aliases resolve to one digest, and that the GitHub
Release exists with its assets. It is a release verification tool and is not part of the running
service.
