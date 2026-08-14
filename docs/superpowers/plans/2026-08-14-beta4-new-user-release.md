# RoleFlow beta.4 New User Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `v0.1.0-beta.4` with a standard Windows installer as the primary new-user download, a checksum, and a clearly labeled advanced portable ZIP, while keeping legacy BAT entry points out of the standard installation.

**Architecture:** Reuse the existing Inno Setup build and portable packager. Tighten the installer stage manifest, add one real filesystem regression check, update version/user-facing copy, and extend the existing tag workflow to publish all three assets from one tested commit.

**Tech Stack:** PowerShell 5.1+, Node.js 22.23.1, Inno Setup 6, GitHub Actions, GitHub Releases.

## Global Constraints

- The release tag is exactly `v0.1.0-beta.4`; package version is exactly `0.1.0-beta.4`.
- The standard installer excludes `Install.bat`, `Start.bat`, `ScanPortable.bat`, and `StartPortableEdge.bat`.
- The source tree and advanced portable ZIP keep the BAT entry points.
- Release assets are exactly the installer EXE, its `.sha256`, and `RoleFlow-v0.1.0-beta.4-portable.zip`.
- Do not overwrite or delete historical tags or Releases.
- Do not package databases, resumes, model secrets, logs, reports, browser profiles, tests, or Edge Control.
- Do not change BOSS browser behavior, `trusted_pane`, `search_page_api`, scan quality, or Wave 5.
- Run BOSS-free offline and installer checks only.

---

### Task 1: Enforce the standard-installer file boundary

**Files:**
- Modify: `tests/windows_installer_smoke.js`
- Modify: `scripts/build-installer.ps1`

**Interfaces:**
- Consumes: `scripts/build-installer.ps1 -StageOnly -SkipTests -BuildRoot <path> -OutputDir <path> -PortableNodeRoot <path>`.
- Produces: an installer stage with production files and no legacy root BAT entry points.

- [ ] **Step 1: Add the failing stage-content regression check**

Add this call after the existing static installer checks:

```js
assertStandardInstallerStageExcludesLegacyEntrypoints();
```

Add a helper that creates an isolated build root, runs the real stage builder, reads the printed `Installer stage:` path, and asserts:

```js
for (const relativePath of [
  "Install.bat",
  "Start.bat",
  "ScanPortable.bat",
  "StartPortableEdge.bat"
]) {
  assert(
    !fs.existsSync(path.join(stageDir, relativePath)),
    `standard installer must exclude ${relativePath}`
  );
}
```

Use `process.execPath` as the pinned Node executable, pass its parent as `-PortableNodeRoot`, set `windowsHide: true`, and remove the isolated fixture in `finally`.

- [ ] **Step 2: Run the focused test and verify the new assertion fails**

Run:

```powershell
& "D:\hermes\node\node.exe" tests\windows_installer_smoke.js
```

Expected: FAIL because the current installer stage still contains at least `Install.bat`.

- [ ] **Step 3: Remove legacy BAT files from the standard installer manifest**

In the first production-file array in `scripts/build-installer.ps1`, remove:

```powershell
"Install.bat",
"Start.bat",
"ScanPortable.bat",
"StartPortableEdge.bat"
```

Do not remove the corresponding source files and do not change `scripts/package-release.ps1`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```powershell
& "D:\hermes\node\node.exe" tests\windows_installer_smoke.js
```

Expected: `windows_installer_smoke ok`.

- [ ] **Step 5: Commit**

```powershell
git add -- tests/windows_installer_smoke.js scripts/build-installer.ps1
git commit -m "fix: keep legacy entrypoints out of installer"
```

### Task 2: Present beta.4 as a true new-user release

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Create: `docs/releases/v0.1.0-beta.4.md`

**Interfaces:**
- Consumes: the approved release design and the merged beta.4 Wave 4 changes.
- Produces: one version value shared by the installer, tag, badge, and release notes; user-facing instructions that distinguish installer, portable ZIP, and Source code.

- [ ] **Step 1: Bump package metadata**

Change the three existing `0.1.0-beta.3` package-version values in `package.json` and `package-lock.json` to:

```json
"version": "0.1.0-beta.4"
```

- [ ] **Step 2: Update the README download path**

Update the release badge to `v0.1.0-beta.4`. Before the current Windows setup steps, add:

```markdown
> **普通 Windows 用户请前往 [v0.1.0-beta.4 下载页](https://github.com/daydreamer0213/roleflow/releases/tag/v0.1.0-beta.4)，下载 `RoleFlow-Setup-0.1.0-beta.4.exe`。**
> `RoleFlow-v0.1.0-beta.4-portable.zip` 是高级免安装版；GitHub 自动生成的 Source code 压缩包不是安装程序。
```

Replace the standard-user step that tells installed users to run `Start.bat` with instructions to prepare the two fixed Edge tabs before starting a scan from RoleFlow. Keep lower advanced/source documentation for `Start.bat`.

- [ ] **Step 3: Write beta.4 release notes**

Create `docs/releases/v0.1.0-beta.4.md` with these exact sections:

```markdown
# RoleFlow v0.1.0-beta.4

## 普通用户下载
## 本版改进
## 验收证据
## 已知限制
## 许可
```

The first section must name the EXE as recommended, the portable ZIP as advanced, and Source code as non-installer. Record only verified merged behavior and fresh final checks; disclose unsigned installer, Edge Control non-redistribution, conditional Wave 4 acceptance, no real communication execution, and AGPL commercial-use boundary.

- [ ] **Step 4: Run metadata and focused documentation checks**

Run:

```powershell
& "D:\hermes\node\node.exe" tests\self_check.js
Select-String -LiteralPath package.json,package-lock.json,README.md,docs\releases\v0.1.0-beta.4.md -Pattern "0.1.0-beta.3"
```

Expected: `self_check ok`; the search returns no stale beta.3 version in the four modified files.

- [ ] **Step 5: Commit**

```powershell
git add -- package.json package-lock.json README.md docs/releases/v0.1.0-beta.4.md
git commit -m "docs: prepare beta4 new user release"
```

### Task 3: Publish all release assets from the tag workflow

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `scripts/package-release.ps1`, `scripts/build-installer.ps1`, `package.json`, and the preinstalled Inno Setup on GitHub's `windows-latest` image.
- Produces: a prerelease containing one EXE, one checksum, and one advanced portable ZIP from the tagged commit.

- [ ] **Step 1: Add version/tag validation**

Before packaging, add a PowerShell step that loads `package.json` and fails unless:

```powershell
$env:GITHUB_REF_NAME -eq "v$($package.version)"
```

- [ ] **Step 2: Rename the portable asset**

Change the packager call to:

```powershell
./scripts/package-release.ps1 -OutputName "RoleFlow-${{ github.ref_name }}-portable.zip"
```

- [ ] **Step 3: Build the installer from the same tested checkout**

After portable packaging, derive the setup-node runtime root and invoke:

```powershell
$nodeRoot = Split-Path -Parent (Get-Command node -ErrorAction Stop).Source
./scripts/build-installer.ps1 `
  -OutputDir (Join-Path $PWD "dist") `
  -PortableNodeRoot $nodeRoot `
  -SkipTests
```

The existing build script resolves the preinstalled Inno Setup compiler from its standard Program Files path.

- [ ] **Step 4: Upload all three assets**

Replace the one-file upload with a loop over:

```powershell
$assetPaths = @(
  "dist/RoleFlow-$env:GITHUB_REF_NAME-portable.zip",
  "dist/RoleFlow-Setup-$($package.version).exe",
  "dist/RoleFlow-Setup-$($package.version).exe.sha256"
)
```

Upload ZIP as `application/zip`, EXE as `application/vnd.microsoft.portable-executable`, and checksum as `text/plain`.

- [ ] **Step 5: Review workflow syntax and diff**

Run:

```powershell
git diff --check
git diff -- .github/workflows/release.yml
```

Expected: no whitespace errors; the diff shows one test run, one installer build with `-SkipTests`, and exactly three uploaded assets.

- [ ] **Step 6: Commit**

```powershell
git add -- .github/workflows/release.yml
git commit -m "ci: publish installer with beta releases"
```

### Task 4: Build and verify the beta.4 artifacts locally

**Files:**
- Verify only: repository and generated `dist/`

**Interfaces:**
- Consumes: all implementation commits.
- Produces: fresh offline evidence and locally inspectable beta.4 EXE, checksum, and portable ZIP.

- [ ] **Step 1: Run the complete offline suite**

Run:

```powershell
& "D:\hermes\node\node.exe" --disable-warning=ExperimentalWarning tests\run_all.js
```

Expected: every offline check passes.

- [ ] **Step 2: Build the advanced portable ZIP**

Run:

```powershell
.\scripts\package-release.ps1 -OutputName "RoleFlow-v0.1.0-beta.4-portable.zip"
```

Expected: `dist\RoleFlow-v0.1.0-beta.4-portable.zip`.

- [ ] **Step 3: Build the standard installer without repeating the suite**

Run:

```powershell
.\scripts\build-installer.ps1 -SkipTests
```

Expected:

```text
dist\RoleFlow-Setup-0.1.0-beta.4.exe
dist\RoleFlow-Setup-0.1.0-beta.4.exe.sha256
```

- [ ] **Step 4: Inspect artifact contents and hashes**

Verify the installer stage excludes legacy BATs and forbidden runtime data. Expand the portable ZIP into an isolated `D:\DevData` directory and verify it keeps the legacy BATs but excludes real databases, secrets, logs, reports, profiles, and Edge Control.

Run `Get-FileHash -Algorithm SHA256` for both EXE and ZIP, and compare the EXE hash with the `.sha256` file.

- [ ] **Step 5: Commit any evidence-only release-note correction**

If the fresh check count differs from the release note, update only the count and commit:

```powershell
git add -- docs/releases/v0.1.0-beta.4.md
git commit -m "docs: record beta4 release verification"
```

If it already matches, do not create an empty commit.

### Task 5: Publish and simulate the downloaded new-user path

**Files:**
- External write: push `main`, create/push tag `v0.1.0-beta.4`, create GitHub prerelease through the tag workflow.
- Verify only: a new isolated download/install directory under `D:\DevData`.

**Interfaces:**
- Consumes: clean verified `main`.
- Produces: public GitHub prerelease with verified assets and a read-only new-user acceptance record.

- [ ] **Step 1: Push main**

Run:

```powershell
git push origin main
```

Expected: `origin/main` advances to the verified release commit.

- [ ] **Step 2: Create and push the release tag**

Run:

```powershell
git tag -a v0.1.0-beta.4 -m "RoleFlow v0.1.0-beta.4"
git push origin v0.1.0-beta.4
```

Do not move the tag after publication.

- [ ] **Step 3: Monitor the tag workflow**

Use GitHub CLI to wait for the `Publish release` run. If it fails, diagnose the actual log before changing code; do not replace or silently bypass a failed asset.

- [ ] **Step 4: Verify the public Release**

Read the Release back and confirm:

- prerelease tag is `v0.1.0-beta.4`;
- exactly the intended EXE, checksum, and portable ZIP are present;
- filenames and versions match;
- historical beta.3 remains unchanged.

- [ ] **Step 5: Re-download and verify the public installer**

Download the published EXE and `.sha256` into a new isolated directory under `D:\DevData`, then compare SHA-256 with the local verified artifact.

- [ ] **Step 6: Simulate first install without touching existing user data**

Install silently into a new explicit directory under `D:\DevData`, with desktop shortcut disabled and launch suppressed. Inspect:

- Windows uninstall registration exists for that isolated installation;
- installed files exclude legacy BATs and forbidden user/runtime data;
- installed launcher and self-check dependencies are present;
- no RoleFlow/BOSS scan or communication process is started.

Uninstall the isolated copy, verify program files are removed and no path outside the explicit test directory is touched. Do not delete or alter the user's existing RoleFlow workspace or BOSS browser state.

- [ ] **Step 7: Final repository check**

Run:

```powershell
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
git rev-list -n 1 v0.1.0-beta.4
```

Expected: clean worktree; `HEAD`, `origin/main`, and tag target are the same verified commit.
