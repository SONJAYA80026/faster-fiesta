/* eslint-disable no-sync */
/// <reference path="./globals.d.ts" />

import * as path from 'path'
import * as cp from 'child_process'
import * as fs from 'fs-extra'
import packager, {
  OfficialArch,
  OsxNotarizeOptions,
  OsxSignOptions,
  Options,
} from 'electron-packager'
import frontMatter from 'front-matter'
import { externals } from '../app/webpack.common'

interface IChooseALicense {
  readonly title: string
  readonly nickname?: string
  readonly featured?: boolean
  readonly hidden?: boolean
}

export interface ILicense {
  readonly name: string
  readonly featured: boolean
  readonly body: string
  readonly hidden: boolean
}

import {
  getBundleID,
  getCompanyName,
  getProductName,
} from '../app/package-info'

import {
  getChannel,
  getDistRoot,
  getExecutableName,
  isPublishable,
  getIconFileName,
} from './dist-info'
import { isCircleCI, isGitHubActions } from './build-platforms'

import { updateLicenseDump } from './licenses/update-license-dump'
import { verifyInjectedSassVariables } from './validate-sass/validate-all'

const projectRoot = path.join(__dirname, '..')
const entitlementsPath = `${projectRoot}/script/entitlements.plist`
const extendInfoPath = `${projectRoot}/script/info.plist`
const outRoot = path.join(projectRoot, 'out')

const isPublishableBuild = isPublishable()
const isDevelopmentBuild = getChannel() === 'development'

console.log(`Building for ${getChannel()}…`)

console.log('Removing old distribution…')
fs.removeSync(getDistRoot())

console.log('Copying dependencies…')
copyDependencies()

console.log('Packaging emoji…')
copyEmoji()

console.log('Copying static resources…')
copyStaticResources()

console.log('Parsing license metadata…')
generateLicenseMetadata(outRoot)

moveAnalysisFiles()

if (isGitHubActions() && process.platform === 'darwin' && isPublishableBuild) {
  console.log('Setting up keychain…')
  cp.execSync(path.join(__dirname, 'setup-macos-keychain'))
}

verifyInjectedSassVariables(outRoot)
  .catch(err => {
    console.error(
      'Error verifying the Sass variables in the rendered app. This is fatal for a published build.'
    )

    if (!isDevelopmentBuild) {
      process.exit(1)
    }
  })
  .then(() => {
    console.log('Updating our licenses dump…')
    return updateLicenseDump(projectRoot, outRoot).catch(err => {
      console.error(
        'Error updating the license dump. This is fatal for a published build.'
      )
      console.error(err)

      if (!isDevelopmentBuild) {
        process.exit(1)
      }
    })
  })
  .then(() => {
    console.log('Packaging…')
    return packageApp()
  })
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
  .then(appPaths => {
    console.log(`Built to ${appPaths}`)
  })

/**
 * The additional packager options not included in the existing typing.
 *
 * See https://github.com/desktop/desktop/issues/2429 for some history on this.
 */
interface IPackageAdditionalOptions {
  readonly protocols: ReadonlyArray<{
    readonly name: string
    readonly schemes: ReadonlyArray<string>
  }>
  readonly osxSign: OsxSignOptions & {
    readonly hardenedRuntime?: boolean
  }
}

function packageApp() {
  // not sure if this is needed anywhere, so I'm just going to inline it here
  // for now and see what the future brings...
  const toPackagePlatform = (platform: NodeJS.Platform) => {
    if (platform === 'win32' || platform === 'darwin' || platform === 'linux') {
      return platform
    }
    throw new Error(
      `Unable to convert to platform for electron-packager: '${process.platform}`
    )
  }

  const toPackageArch = (targetArch: string | undefined): OfficialArch => {
    if (targetArch === undefined) {
      return 'x64'
    }

    if (targetArch === 'arm64' || targetArch === 'x64') {
      return targetArch
    }

    throw new Error(
      `Building Desktop for architecture '${targetArch}'  is not supported`
    )
  }

  // get notarization deets, unless we're not going to publish this
  const notarizationCredentials = isPublishableBuild
    ? getNotarizationCredentials()
    : undefined
  if (
    isPublishableBuild &&
    (isCircleCI() || isGitHubActions()) &&
    process.platform === 'darwin' &&
    notarizationCredentials === undefined
  ) {
    // we can't publish a mac build without these
    throw new Error(
      'Unable to retreive appleId and/or appleIdPassword to notarize macOS build'
    )
  }

  const options: Options & IPackageAdditionalOptions = {
    name: getExecutableName(),
    platform: toPackagePlatform(process.platform),
    arch: toPackageArch(process.env.TARGET_ARCH),
    asar: false, // TODO: Probably wanna enable this down the road.
    out: getDistRoot(),
    icon: path.join(projectRoot, 'app', 'static', 'logos', getIconFileName()),
    dir: outRoot,
    overwrite: true,
    tmpdir: false,
    derefSymlinks: false,
    prune: false, // We'll prune them ourselves below.
    ignore: [
      new RegExp('/node_modules/electron($|/)'),
      new RegExp('/node_modules/electron-packager($|/)'),
      new RegExp('/\\.git($|/)'),
      new RegExp('/node_modules/\\.bin($|/)'),
    ],
    appCopyright: 'Copyright © 2017 GitHub, Inc.',

    // macOS
    appBundleId: getBundleID(),
    appCategoryType: 'public.app-category.developer-tools',
    darwinDarkModeSupport: true,
    osxSign: {
      hardenedRuntime: true,
      entitlements: entitlementsPath,
      'entitlements-inherit': entitlementsPath,
      type: isPublishableBuild ? 'distribution' : 'development',
    },
    osxNotarize: notarizationCredentials,
    protocols: [
      {
        name: getBundleID(),
        schemes: [
          !isDevelopmentBuild
            ? 'x-github-desktop-auth'
            : 'x-github-desktop-dev-auth',
          'x-github-client',
          'github-mac',
        ],
      },
    ],
    extendInfo: extendInfoPath,

    // Windows
    win32metadata: {
      CompanyName: getCompanyName(),
      FileDescription: '',
      OriginalFilename: '',
      ProductName: getProductName(),
      InternalName: getProductName(),
    },
  }

  return packager(options)
}

function removeAndCopy(source: string, destination: string) {
  fs.removeSync(destination)
  fs.copySync(source, destination)
}

function copyEmoji() {
  const emojiImages = path.join(projectRoot, 'gemoji', 'images', 'emoji')
  const emojiImagesDestination = path.join(outRoot, 'emoji')
  removeAndCopy(emojiImages, emojiImagesDestination)

  const emojiJSON = path.join(projectRoot, 'gemoji', 'db', 'emoji.json')
  const emojiJSONDestination = path.join(outRoot, 'emoji.json')
  removeAndCopy(emojiJSON, emojiJSONDestination)
}

function copyStaticResources() {
  const dirName = process.platform
  const platformSpecific = path.join(projectRoot, 'app', 'static', dirName)
  const common = path.join(projectRoot, 'app', 'static', 'common')
  const destination = path.join(outRoot, 'static')
  fs.removeSync(destination)
  if (fs.existsSync(platformSpecific)) {
    fs.copySync(platformSpecific, destination)
  }
  fs.copySync(common, destination, { overwrite: false })
}

function moveAnalysisFiles() {
  const rendererReport = 'renderer.report.html'
  const analysisSource = path.join(outRoot, rendererReport)
  if (fs.existsSync(analysisSource)) {
    const distRoot = getDistRoot()
    const destination = path.join(distRoot, rendererReport)
    fs.mkdirpSync(distRoot)
    // there's no moveSync API here, so let's do it the old fashioned way
    //
    // unlinkSync below ensures that the analysis file isn't bundled into
    // the app by accident
    fs.copySync(analysisSource, destination, { overwrite: true })
    fs.unlinkSync(analysisSource)
  }
}

function copyDependencies() {
  const originalPackage: Package = require(path.join(
    projectRoot,
    'app',
    'package.json'
  ))

  const oldDependencies = originalPackage.dependencies
  const newDependencies: PackageLookup = {}

  for (const name of Object.keys(oldDependencies)) {
    const spec = oldDependencies[name]
    if (externals.indexOf(name) !== -1) {
      newDependencies[name] = spec
    }
  }

  const oldDevDependencies = originalPackage.devDependencies
  const newDevDependencies: PackageLookup = {}

  if (isDevelopmentBuild) {
    for (const name of Object.keys(oldDevDependencies)) {
      const spec = oldDevDependencies[name]
      if (externals.indexOf(name) !== -1) {
        newDevDependencies[name] = spec
      }
    }
  }

  // The product name changes depending on whether it's a prod build or dev
  // build, so that we can have them running side by side.
  const updatedPackage = Object.assign({}, originalPackage, {
    productName: getProductName(),
    dependencies: newDependencies,
    devDependencies: newDevDependencies,
  })

  if (!isDevelopmentBuild) {
    delete updatedPackage.devDependencies
  }

  fs.writeFileSync(
    path.join(outRoot, 'package.json'),
    JSON.stringify(updatedPackage)
  )

  fs.removeSync(path.resolve(outRoot, 'node_modules'))

  if (
    Object.keys(newDependencies).length ||
    Object.keys(newDevDependencies).length
  ) {
    console.log('  Installing dependencies via yarn…')
    cp.execSync('yarn install', { cwd: outRoot, env: process.env })
  }

  console.log('  Copying desktop-trampoline…')
  const desktopTrampolineDir = path.resolve(outRoot, 'desktop-trampoline')
  const desktopTrampolineFile =
    process.platform === 'win32'
      ? 'desktop-trampoline.exe'
      : 'desktop-trampoline'
  fs.removeSync(desktopTrampolineDir)
  fs.mkdirSync(desktopTrampolineDir)
  fs.copySync(
    path.resolve(
      projectRoot,
      'app/node_modules/desktop-trampoline/build/Release',
      desktopTrampolineFile
    ),
    path.resolve(desktopTrampolineDir, desktopTrampolineFile)
  )

  console.log('  Copying git environment…')
  const gitDir = path.resolve(outRoot, 'git')
  fs.removeSync(gitDir)
  fs.mkdirpSync(gitDir)
  fs.copySync(path.resolve(projectRoot, 'app/node_modules/dugite/git'), gitDir)

  if (process.platform === 'win32') {
    console.log('  Cleaning unneeded Git components…')
    const files = [
      'Bitbucket.Authentication.dll',
      'GitHub.Authentication.exe',
      'Microsoft.Alm.Authentication.dll',
      'Microsoft.Alm.Git.dll',
      'Microsoft.IdentityModel.Clients.ActiveDirectory.Platform.dll',
      'Microsoft.IdentityModel.Clients.ActiveDirectory.dll',
      'Microsoft.Vsts.Authentication.dll',
      'git-askpass.exe',
      'git-credential-manager.exe',
    ]

    const gitCoreDir = path.join(gitDir, 'mingw64', 'libexec', 'git-core')

    for (const file of files) {
      const filePath = path.join(gitCoreDir, file)
      try {
        fs.unlinkSync(filePath)
      } catch (err) {
        // probably already cleaned up
      }
    }
  }

  if (process.platform === 'darwin') {
    console.log('  Copying app-path binary…')
    const appPathMain = path.resolve(outRoot, 'main')
    fs.removeSync(appPathMain)
    fs.copySync(
      path.resolve(projectRoot, 'app/node_modules/app-path/main'),
      appPathMain
    )
  }
}

function generateLicenseMetadata(outRoot: string) {
  const chooseALicense = path.join(outRoot, 'static', 'choosealicense.com')
  const licensesDir = path.join(chooseALicense, '_licenses')

  const files = fs.readdirSync(licensesDir)

  const licenses = new Array<ILicense>()
  for (const file of files) {
    const fullPath = path.join(licensesDir, file)
    const contents = fs.readFileSync(fullPath, 'utf8')
    const result = frontMatter<IChooseALicense>(contents)

    const licenseText = result.body.trim()
    // ensure that any license file created in the app does not trigger the
    // "no newline at end of file" warning when viewing diffs
    const licenseTextWithNewLine = `${licenseText}\n`

    const license: ILicense = {
      name: result.attributes.nickname || result.attributes.title,
      featured: result.attributes.featured || false,
      hidden:
        result.attributes.hidden === undefined || result.attributes.hidden,
      body: licenseTextWithNewLine,
    }

    if (!license.hidden) {
      licenses.push(license)
    }
  }

  const licensePayload = path.join(outRoot, 'static', 'available-licenses.json')
  const text = JSON.stringify(licenses)
  fs.writeFileSync(licensePayload, text, 'utf8')

  // embed the license alongside the generated license payload
  const chooseALicenseLicense = path.join(chooseALicense, 'LICENSE.md')
  const licenseDestination = path.join(
    outRoot,
    'static',
    'LICENSE.choosealicense.md'
  )

  const licenseText = fs.readFileSync(chooseALicenseLicense, 'utf8')
  const licenseWithHeader = `GitHub Desktop uses licensing information provided by choosealicense.com.

The bundle in available-licenses.json has been generated from a source list provided at https://github.com/github/choosealicense.com, which is made available under the below license:

------------

${licenseText}`

  fs.writeFileSync(licenseDestination, licenseWithHeader, 'utf8')

  // sweep up the choosealicense directory as the important bits have been bundled in the app
  fs.removeSync(chooseALicense)
}

function getNotarizationCredentials(): OsxNotarizeOptions | undefined {
  const appleId = process.env.APPLE_ID
  const appleIdPassword = process.env.APPLE_ID_PASSWORD
  if (appleId === undefined || appleIdPassword === undefined) {
    return undefined
  }
  return {
    appleId,
    appleIdPassword,
  }
}
