#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const checkOnly = process.argv.includes("--check")

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8")
}

function writeText(filePath, value) {
  fs.writeFileSync(filePath, value)
}

function readJson(filePath) {
  return JSON.parse(readText(filePath))
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function computeVersionCode(versionName) {
  const cleanVersion = versionName.split(/[+-]/)[0]
  const parts = cleanVersion.split(".").map((part) => {
    if (!/^\d+$/.test(part)) {
      throw new Error(`Invalid native version segment "${part}" in ${versionName}`)
    }
    return Number.parseInt(part, 10)
  })
  const [major = 0, minor = 0, patch = 0] = parts
  const versionCode = major * 1_000_000 + minor * 1_000 + patch

  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) {
    throw new Error(`Computed Android/iOS build number ${versionCode} is outside the valid range`)
  }

  return versionCode
}

function replaceRequired(source, pattern, replacement, filePath, label) {
  if (!pattern.test(source)) {
    throw new Error(`Could not find ${label} in ${path.relative(root, filePath)}`)
  }
  return source.replace(pattern, replacement)
}

function stageTextUpdate(filePath, nextValue, changedFiles) {
  const currentValue = readText(filePath)
  if (currentValue === nextValue) return
  changedFiles.push(path.relative(root, filePath))
  if (!checkOnly) writeText(filePath, nextValue)
}

function stageJsonUpdate(filePath, nextValue, changedFiles) {
  const currentValue = readText(filePath)
  const expectedValue = `${JSON.stringify(nextValue, null, 2)}\n`
  if (currentValue === expectedValue) return
  changedFiles.push(path.relative(root, filePath))
  if (!checkOnly) writeJson(filePath, nextValue)
}

function replaceSignedReleaseTag(source, versionName, filePath = path.join(root, ".github/workflows/native-release.yml")) {
  return replaceRequired(
    source,
    /(^ {6}release_tag:[^\S\r\n]*\r?\n(?:^ {8}[^\r\n]*\r?\n)*?^ {8}default:[^\S\r\n]*)['"]?[^'"\s#]+['"]?/m,
    `$1native-v${versionName}`,
    filePath,
    "signed release workflow default tag",
  )
}

function main() {
  const packagePath = path.join(root, "package.json")
  const desktopPackagePath = path.join(root, "apps/desktop/package.json")
  const androidBuildPath = path.join(root, "android/app/build.gradle")
  const iosProjectPath = path.join(root, "ios/App/App.xcodeproj/project.pbxproj")
  const nativeReleaseWorkflowPath = path.join(root, ".github/workflows/native-release.yml")
  const packageJson = readJson(packagePath)
  const versionName = String(process.env.SIRAGPT_NATIVE_VERSION_NAME || packageJson.version || "").trim()

  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(versionName)) {
    throw new Error(`package.json version must be semver-like for native stores; got "${versionName}"`)
  }

  const versionCode = Number.parseInt(
    process.env.SIRAGPT_NATIVE_VERSION_CODE || String(computeVersionCode(versionName)),
    10,
  )

  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) {
    throw new Error(`SIRAGPT_NATIVE_VERSION_CODE must be a valid store build number; got "${versionCode}"`)
  }

  const changedFiles = []

  const androidBuild = readText(androidBuildPath)
  let nextAndroidBuild = replaceRequired(
    androidBuild,
    /versionCode\s+\d+/,
    `versionCode ${versionCode}`,
    androidBuildPath,
    "Android versionCode",
  )
  nextAndroidBuild = replaceRequired(
    nextAndroidBuild,
    /versionName\s+["'][^"']+["']/,
    `versionName "${versionName}"`,
    androidBuildPath,
    "Android versionName",
  )
  stageTextUpdate(androidBuildPath, nextAndroidBuild, changedFiles)

  const iosProject = readText(iosProjectPath)
  let nextIosProject = replaceRequired(
    iosProject,
    /^(\s*)CURRENT_PROJECT_VERSION = [^;]+;/gm,
    `$1CURRENT_PROJECT_VERSION = ${versionCode};`,
    iosProjectPath,
    "iOS CURRENT_PROJECT_VERSION",
  )
  nextIosProject = replaceRequired(
    nextIosProject,
    /^(\s*)MARKETING_VERSION = [^;]+;/gm,
    `$1MARKETING_VERSION = ${versionName};`,
    iosProjectPath,
    "iOS MARKETING_VERSION",
  )
  stageTextUpdate(iosProjectPath, nextIosProject, changedFiles)

  const desktopPackage = readJson(desktopPackagePath)
  if (desktopPackage.version !== versionName) {
    desktopPackage.version = versionName
    stageJsonUpdate(desktopPackagePath, desktopPackage, changedFiles)
  }

  const nativeReleaseWorkflow = readText(nativeReleaseWorkflowPath)
  const nextNativeReleaseWorkflow = replaceSignedReleaseTag(
    nativeReleaseWorkflow,
    versionName,
    nativeReleaseWorkflowPath,
  )
  stageTextUpdate(nativeReleaseWorkflowPath, nextNativeReleaseWorkflow, changedFiles)

  if (changedFiles.length > 0) {
    const fileList = changedFiles.join(", ")
    if (checkOnly) {
      console.error(`native-version: out of sync for ${versionName} (${versionCode}): ${fileList}`)
      process.exit(1)
    }
    console.log(`native-version: synced ${versionName} (${versionCode}) in ${fileList}`)
    return
  }

  console.log(`native-version: already synced ${versionName} (${versionCode})`)
}

module.exports = {
  computeVersionCode,
  replaceSignedReleaseTag,
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`native-version: ${error.message}`)
    process.exit(1)
  }
}
