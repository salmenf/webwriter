import {z} from "zod"
import { cargoQueue, map } from "async"
import MiniSearch from "minisearch"
import merge from "lodash.merge"

import { capitalizeWord, escapeRegex, filterObject, hashCode, unscopePackageName } from "../../utility"
import { Environment, WatchEvent } from "../environment"
import { CustomElementsManifest, ManifestCustomElementDeclaration, ManifestDeclaration, ManifestPropertyLike, MemberSettings, NpmName, Package, SemVer, SnippetEditingSettings, ThemeEditingSettings, WidgetEditingSettings, themes } from ".."
import {version as appVersion} from "../../package.json"
import { licenses, presets } from "../templates"
import { toJS } from "mobx"
import { ImportMap } from "@jspm/import-map"
import { msg } from "@lit/localize"

type Options = {
  corePackages?: Package["name"][]
  onBundleChange?: (packages: Package[]) => void,
  watching?: Record<string, boolean>,
  initializePackages?: boolean,
  apiBase?: string
} & Environment

type Snippet = {
  id: string,
  label?: Record<string, string>,
  html: string
}

type PmQueueTask = {
  command: "install" | "add" | "remove" | "update",
  parameters: string[],
  handle?: FileSystemDirectoryHandle,
  cwd?: string,
  name?: string
}

type PackageCache = Record<string, Pick<Package, typeof Package["coreKeys"] | "members">>

const IMAGE_FILE_EXTENSIONS = [".apng", ".jpg", ".jpeg", ".jfif", ".pjpeg", ".pjp", ".png", ".svg", ".webp", ".bmp", ".ico", ".cur", ".tif", ".tiff"]
const AUDIO_FILE_EXTENSIONS = [".wav", ".wave", ".mp3", ".aac", ".aacp", ".oga", ".flac", ".weba"]
const VIDEO_FILE_EXTENSIONS = [".mp4", ".webm", ".avif", ".gif", ".mov", ".avi", ".ogv", ".mkv", ".opus", ".mpeg"]
const FONT_FILE_EXTENSIONS = [".woff", ".woff2", ".ttf", ".otf"]

const BUNDLE_LOADER_MAP = {
  "dataurl": [...IMAGE_FILE_EXTENSIONS, ...AUDIO_FILE_EXTENSIONS, ...VIDEO_FILE_EXTENSIONS, FONT_FILE_EXTENSIONS, ".pdf"],
  "json": [".json", ".jsonld"],
  "text": [".txt", ".csv", ".htm", ".html", ".xml"]
}

const BUNDLE_LOADER_OPTIONS = Object.entries(BUNDLE_LOADER_MAP).flatMap(([loader, exts]) => exts.map(ext => `--loader:${ext}=${loader}`))


export class PackageIssue extends Error {}
export class ServiceIssue extends PackageIssue {}
export class ReadWriteIssue extends PackageIssue {}
export class InstallIssue extends PackageIssue {}
export class UninstallIssue extends PackageIssue {}
export class UpdateIssue extends PackageIssue {}
export class BundleIssue extends PackageIssue {

  stack?: string
  id?: string

  constructor(message?: string, options?: ErrorOptions & {stack?: string, id?: string}) {
    super(message, options)
    this.stack = options?.stack
    this.id = options?.id
  }

  toJSON() {
    return {id: this.id, stack: this.stack, message: this.message, cause: this.cause}
  }
}
export class WidgetNameIssue extends Error {}
export class PackageJsonIssue extends Error {}
export class Warning extends Error {}

/** Handles packages. Packages are node (npm) packages which contain widgets. The PackageStore can also create bundles from packages, which can for example be imported by the runtime editor or embedded by serializers. Additionally, the PackageStore can open or clear the app directory which stores the packages. */
export class PackageStore {

  importMap: ImportMap

  set installedPackages(value: string[]) {
    let valueUnique = Array.from(new Set(value))
    valueUnique = valueUnique.filter(a => !valueUnique.some(b => b !== a && b.startsWith("@" + a.split("@")[1])))
    localStorage.setItem("webwriter_installedPackages", JSON.stringify(valueUnique))
  }

  get installedPackages() {
    return JSON.parse(localStorage.getItem("webwriter_installedPackages") ?? "[]")
  }

  static get bundleOptions()  {return [
    "--bundle",
    `--outdir=./bundlecache`,
    `--entry-names=[dir]/[name].bundle`,
    `--metafile=bundlecache/meta.json`,
    "--target=es2022",
    `--format=esm`,
    "--conditions=source",
    ...BUNDLE_LOADER_OPTIONS
  ]}

  static developmentBundleOptions = ["--sourcemap=inline"]
  static productionBundleOptions = ["--drop-labels=DEV", "--minify"]

  updateOnStartup = true

  apiBase: string

  private db = indexedDB.open("webwriter", 1)

  private static async readFileIfExists(path: string, FS: Environment["FS"]): Promise<string | undefined> {
    return await FS.exists(path)? await FS.readFile(path) as string: undefined
  }

  private static isLocalImportID(id: string) {
    const match = id.match(SemVer.pattern)
    return match? (new SemVer(match[0]).prerelease[0] as any)?.includes("local"): undefined
  }

  private static async bundlePath(importIDs: string[], Path: Environment["Path"], FS: Environment["FS"], production=false) {
    const includesLocal = importIDs.some(this.isLocalImportID)
    const hash = PackageStore.computeBundleHash(importIDs, production)
    const appDir = await Path.appDir()
    const jsPath = await Path.join(appDir, "bundlecache", `${hash}.bundle.js`)
    const jsPathRelative = ["bundlecache", `${hash}.bundle.js`].join("/")
    const cssPath = await Path.join(appDir, "bundlecache", `${hash}.bundle.css`)
    const cssPathRelative = ["bundlecache", `${hash}.bundle.css`].join("/")
    const entryPath = await Path.join(appDir, "bundlecache", `${hash}.js`)
    const entryPathRelative = ["bundlecache", `${hash}.js`].join("/")
    const metaPath = await Path.join(appDir, "bundlecache", `${hash}.meta.json`)
    const metaPathRelative = ["bundlecache", `${hash}.meta.json`].join("/")
    return {
      hash,
      jsExists: !includesLocal && await FS.exists(jsPath),
      jsPath,
      jsPathRelative,
      cssExists: !includesLocal && await FS.exists(cssPath),
      cssPath,
      cssPathRelative,
      entryPath,
      entryPathRelative,
      metaExists: !includesLocal && await FS.exists(metaPath),
      metaPath,
      metaPathRelative,
    }
  }

  static async readBundle(importIDs: string[], bundle: Environment["bundle"], Path: Environment["Path"], FS: Environment["FS"], production=false) {
    if(importIDs.length === 0) {
      return {bundleID: "", bundleJS: "", bundleCSS: "", errors: [] as BundleIssue[]}
    }
    let appDir
    try {
       appDir = await Path.appDir()
    }
    catch(cause) {
      throw new ReadWriteIssue("Could not read path of app directory: " + String(cause), {cause})
    }

    const bundlecacheDir = await Path.join(appDir, "bundlecache")
    if(!(await FS.exists(bundlecacheDir))) {
      await FS.mkdir(bundlecacheDir)
    }

    type BundleData = Awaited<ReturnType<typeof this.bundlePath>> & {bundleID?: string, bundleJS?: string, bundleCSS?: string, importIDs: string[], meta?: {errors: BundleIssue[], cssSize?: number, jsSize?: number, imports: {path: string, kind: string, external?: boolean}[], exports: string[]}}

    const hasUncached = (entry: BundleData) => !entry.metaExists || this.isLocalImportID(entry.bundleID!)

    const writeEntrypoint = async (entry: BundleData) => {
      const entryCode = entry.importIDs
      .map(id => id.replace(new RegExp(`@` + `(local|${SemVer.pattern.source})`, "g"), ""))
      .map(k => `import "${k}"`)
      .join(";")
      try {
        await FS.writeFile(entry.entryPath, entryCode)
      }
      catch(cause) {
        throw new ReadWriteIssue(`Could not create entrypoint file ${entry.entryPath}:\n${cause}`, {cause})
      }
    }
 
    const options = (entries: BundleData[]) => [
      ...entries.map(entry => entry.entryPathRelative),
      ...PackageStore.bundleOptions,
      ...(!production? PackageStore.developmentBundleOptions: PackageStore.productionBundleOptions) 
    ]
    let errors: BundleIssue[] = []

    const esbuildErrorsToBundleIssues = (rawCause: string) => {
      return rawCause
        .split("\n")
        .slice(0, -2)
        .join("\n")
        .split("X [ERROR] ")
        .filter(err => err)
        .map(str => {
          const [message, afterPart] = str.trim().split("\n\n")
          const [location, display] = (afterPart ?? "").trim().split(":\n")
          const nameRegex = /(@[a-z0-9-~][a-z0-9-._~]*\/)[a-z0-9-~][a-z0-9-._~]*/g
          const lineRegex = /\d+ │ .*\n/
          const line = display?.match(lineRegex)![0].trim()
          const id = (location?.replace("node_modules/","").match(nameRegex) ?? [])[0]
          return new BundleIssue(message, {cause: line, stack: location, id})
        })
    }

    const writeMeta = async (bundleData: BundleData[]) => {
      const {metaPath, metaExists} = await this.bundlePath(bundleData.flatMap(entry => entry.importIDs), Path, FS, production)
      const buildMeta = JSON.parse((await this.readFileIfExists(metaPath, FS)) ?? "null")
      await Promise.all(bundleData.map(entry => {
        const entryErrors = errors.filter(e => entry.bundleID?.startsWith(e.id!))
        const entryBuildMetaJS = buildMeta && entry.jsPathRelative in buildMeta? buildMeta?.outputs[entry.jsPathRelative]: {}
        const entryBuildMetaCSS = buildMeta && entry.cssPathRelative in buildMeta? buildMeta?.outputs[entry.cssPathRelative]: {}
        const entryMeta = {
          errors: entryErrors,
          cssSize: entryBuildMetaCSS?.bytes,
          jsSize: entryBuildMetaJS?.bytes,
          imports: entryBuildMetaJS?.imports,
          exports: entryBuildMetaJS?.exports
        }
        return FS.writeFile(entry.metaPath, JSON.stringify(entryMeta))
      }))
      if(await FS.exists(metaPath)) {
        await FS.unlink(metaPath)
      }
    }

    const bundleData = (await Promise.all(importIDs.map(async id => {
      const bundleID = PackageStore.computeBundleID([id], production)
      const bundleStatus = await this.bundlePath([id], Path, FS, production)
      const meta = JSON.parse((await this.readFileIfExists(bundleStatus.metaPath, FS)) ?? "null") as BundleData["meta"]
      return {bundleID, importIDs: [id], ...bundleStatus, meta}
    }))) as BundleData[]
     
    const toBundleSingle = bundleData.filter(hasUncached)
    if(toBundleSingle.length) {
      try {
        await Promise.all(toBundleSingle.map(entry => writeEntrypoint(entry)))
        await bundle(options(toBundleSingle), appDir)
      }
      catch(rawCause) {
        if(typeof rawCause === "string") {
          errors = esbuildErrorsToBundleIssues(rawCause)
        }
        else throw rawCause
      }
      try {
        await writeMeta(toBundleSingle)
      }
      catch(err) {
        console.error(err)
      }
    }
    const importIDsNoErrors = importIDs.filter(id => {
      const currentError = errors.some(err => id.startsWith(err.id!))
      const storedError = bundleData.some(entry => !this.isLocalImportID(id) && entry.importIDs.includes(id) && (entry.meta?.errors.length ?? 0) > 0)
      return !currentError && !storedError
    })
    const compositeWithoutErrors = {
      importIDs: importIDsNoErrors,
      bundleID: PackageStore.computeBundleID(importIDsNoErrors, production),
      ...(await this.bundlePath(importIDsNoErrors, Path, FS, production)),
    }
    if(hasUncached(compositeWithoutErrors)) {
      await writeEntrypoint(compositeWithoutErrors)
      await bundle(options([compositeWithoutErrors]), appDir)
    }
    await writeMeta([compositeWithoutErrors])
    return {
      ...compositeWithoutErrors,
      bundleJS: await this.readFileIfExists(compositeWithoutErrors.jsPath, FS),
      bundleCSS: await this.readFileIfExists(compositeWithoutErrors.cssPath,FS),
      errors
    }
  }


  /** Converts a H5P library object (library.json) into a node package (package.json), including the raw library data under the key "h5pLibrary". */
  static H5PtoPackageJson(name: string, library: Record<string, any>): Package {
    return new Package({
      name,
      version: `${library["majorVersion"]}.${library["minorVersion"]}.${library["patchVersion"]}`,
      description: library["description"],
      license: library["license"],
      author: library["author"],
      keywords: ["webwriter-h5p", "webwriter-widget"],
      h5pLibrary: {...library}
    })
  }

  static computeBundleID(importIDs: string[], production=false, lastLoaded?: number) {
    return importIDs.join(";") + (production? " !PROD": "") + (lastLoaded? `!${lastLoaded}`: "")
  }

  /** Create a hash value to identify a bundle. The hash is deterministically computed from the packages' names and versions. This allows for caching of existing bundles. */
  static computeBundleHash(importIDs: string[], production=false) {
    const ids = importIDs.map(id => id.replace(/-local\d+/, "-local"))
    const bundleID = this.computeBundleID(ids, production)
    return hashCode(bundleID).toString(36)
  }

  static getManifestCustomElements(customElements: CustomElementsManifest) {
    return (customElements?.modules ?? [])
      .flatMap(mod => (mod?.declarations ?? []) as ManifestDeclaration[])
      .filter((decl): decl is ManifestCustomElementDeclaration => "customElement" in decl)
  }

  static settingsFromDeclaration(customElements: CustomElementsManifest | undefined, tag: string) {
    if(!customElements) {
      return {}
    }
    const elementDeclarations = this.getManifestCustomElements(customElements)
    const value = (elementDeclarations.find(decl => decl.tagName === tag)?.members?.find(m => m.kind === "field" && m.static && m.name === "editingConfig" && m.default) as ManifestPropertyLike)?.default
    try {
      return JSON.parse(value ?? "null")
    }
    catch(err: any) {
      console.warn("Error parsing `editingSettings` on widget declaration, using default config instead (must be a valid JSON literal, including quoted property names):" + err?.message)
      return null
    }
  }

  constructor(options: Options) {
    Object.assign(this, options)
    if(!this.apiBase) {
      this.appDir = this.Path.appDir()
      this.rootPackageJsonPath = this.appDir.then(dir => this.Path.join(dir, "package.json"))
      this.localPathsPath = this.appDir.then(dir => this.Path.join(dir, "localpaths.json"))
      this.initialized = options.initializePackages? this.initialize(): Promise.resolve();
      (async () => {
        await this.initialized
        this.watching = options.watching ?? this.watching
      })()
    }
    else {
      this.db.addEventListener("upgradeneeded", () => {
        this.db.result.createObjectStore("handles", {keyPath: "id"})
        this.db.result.createObjectStore("snippets", {keyPath: "id", autoIncrement: true})
      })
    }
  }

  async putLocalHandle(id: string, handle: FileSystemDirectoryHandle) {
    const tx = this.db.result.transaction("handles", "readwrite")
    const store = tx.objectStore("handles")
    const done = new Promise(r => tx.addEventListener("complete", r))
    store.put({id, handle})
    return done
  }

  FS: Environment["FS"]
  Path: Environment["Path"]
  Shell: Environment["Shell"]
  OS: Environment["OS"]
  Dialog: Environment["Dialog"]
  bundle: Environment["bundle"]
  search: Environment["search"]
  pm: Environment["pm"]
  watch: Environment["watch"]
  onBundleChange: Options["onBundleChange"]

  initialized: Promise<void>
  loading: boolean = false
  initializing: boolean = false
  resetting: boolean = false
  appDir: Promise<string>
  rootPackageJsonPath: Promise<string>
  localPathsPath: Promise<string>

  bundleJS: string = ""
  bundleCSS: string = ""
  bundleID: string = ""

  packages: Record<string, Package> = {}

  adding: Record<string, boolean> = {}
  removing: Record<string, boolean> = {}
  updating: Record<string, boolean> = {}

  issues: Record<string, Error[]> & {_?: Error[]} = {}

  get managementIssues() {
    return this.issues._ ?? []
  }

  set managementIssues(_: Error[]) {
    this.issues = {...this.issues, _}
  }

  appendManagementIssues(...issues: Error[]) {
    this.appendPackageIssues("_", ...issues)
  }

  getPackageIssues(id: string) {
    return this.issues[id] ?? []
  }

  setPackageIssues(id: string, issues: Error[]) {
    this.issues[id] = issues
  }

  appendPackageIssues(id: string, ...issues: Error[]) {
    this.issues[id] = [...this.getPackageIssues(id), ...issues]
  }

  get importingId() {
    return Object.keys(this.adding).find(id => this.adding[id] && !(id in this.packages))
  }

  searchIndex = new MiniSearch<Package>({
    fields: ["id", "name", "description", "version", "keywords"],
    extractField: (doc, fieldName) => (fieldName === "keywords"? doc?.keywords?.join(", "): String(doc[fieldName as keyof typeof doc])) ?? "",
    idField: "id"
  })

  searchPackages = (query: string) => {
    return this.searchIndex.search(query, {boost: {id: 5, name: 4, keywords: 3, version: 2, description: 1}, prefix: true, fuzzy: 1})
  }

  async updateImportMap(ids: string[]=this.installedPackages) {
    const url = new URL("_importmaps", this.apiBase)
    url.searchParams.append("pkg", "true")
    /*
    const nonlocalIds = ids.filter(id => {
      const version = id.split("@")[2]
      return !(new SemVer(version)).prerelease.includes("local")
    })
    const localIds = ids.filter(id =>!nonlocalIds.includes(id))
    nonlocalIds.forEach(id => url.searchParams.append("id", id))
    */
    ids.forEach(id => url.searchParams.append("id", id))
    const map = ids.length? await (await fetch(url)).json(): undefined
    this.importMap = new ImportMap({map})
    this.installedPackages = ids
  }

  pmQueue = cargoQueue(async (tasks: PmQueueTask[]) => {
    const toAdd = tasks.filter(t => t.command === "add" && !t.name && !t.handle).flatMap(t => t.parameters)
    const toAddLocal = tasks.filter(t => t.command === "add" && t.handle).flatMap(t => ({handle: t.handle!, name: t.name}))
    const toRemove = tasks.filter(t => t.command === "remove").flatMap(t => t.parameters)
    const toUpdate = tasks.filter(t => t.command === "update").flatMap(t => t.parameters)
    const toLink = tasks.filter(t => t.command === "add" && t.name)
    try {
      if(toRemove.length > 0) {
        try {
          if(!this.apiBase) {
            await this.pm("remove", toRemove, await this.appDir)
            await this.updateLocalLinks()
          }
          else {
            await this.updateImportMap(this.installedPackages.filter(id => !toRemove.includes(id)))
          }
        }
        catch(err) {
          console.error(err)
        }
        finally {
          this.removing = {...this.removing, ...Object.fromEntries(toRemove.map(name => [name, false]))}
        }
      }
      if(toAdd.length > 0) {
        const names = Object.fromEntries(toAdd.map(key => [
          key,
          !key.startsWith("file://")? key: tasks.find(t => t.parameters.includes(key))!.name!
        ]))
        try {
          if(!this.apiBase) {
            await this.pm("add", toAdd, await this.appDir)
          }
          else {
            await this.updateImportMap([...this.installedPackages, ...toAdd])
          }
        }
        catch(err) {
          console.error(err)
        }
        finally {
          this.adding = {...this.adding, ...Object.fromEntries(toAdd.map(name => [names[name], false]))}
        }
      }
      if(toAddLocal.length > 0) {
        try {
          const pkgs = await Promise.all(toAddLocal.map(async ({handle, name}) => {
            const pkgHandle = await handle.getFileHandle("package.json")
            const file = await pkgHandle.getFile()
            const text = await file.text()
            const pkg = new Package({...JSON.parse(text)})
            pkg.version.prerelease = [...pkg.version.prerelease, "local"]
            await this.putLocalHandle(pkg.name, handle)
            return pkg
          }))
          this.updateImportMap([...this.installedPackages, ...pkgs.map(pkg => pkg.id)])
        }
        catch(err) {
          console.error(err)
        }
        finally {
          this.adding = {...this.adding, ...Object.fromEntries(toAddLocal.map(({name}) => [name, false]))}
        }
      }
      if(toLink.length > 0) {
        const pkg = (await this.readRootPackageJson())!
        pkg.localPaths = {
          ...pkg?.localPaths,
          ...Object.fromEntries(toLink.map(t => [t.name!, t.parameters[0]!.replace("file:\/\/", "")])
          )
        }
        await this.updateLocalLinks(pkg.localPaths)
        for(const key of Object.keys(pkg.localPaths)) {
          try {
            await this.pm("link", [key, "--save"], await this.appDir)
          }
          catch(err) {
            console.error(err)
          }
          finally {
            this.adding = {...this.adding, ...Object.fromEntries(toLink.map(task => [task.name, false]))}
          }
        }
        const updatedPkg = (await this.readRootPackageJson())!
        updatedPkg.localPaths = pkg.localPaths
        await this.writeRootPackageJson(updatedPkg)
      }
      if(toUpdate.length > 0) {
        try {
          await this.pm("update", toUpdate, await this.appDir)
        }
        catch(err) {
          console.error(err)
        }
        finally {
          this.updating = {...this.updating, ...Object.fromEntries(toUpdate.map(name => [name, false]))}
        }
      }
    }
    finally {
      await this.load()
    }
  })

  private unwatchCallbacks: Record<string, CallableFunction> = {}

  get watching() {
    return Object.fromEntries(Object.entries(this.unwatchCallbacks).filter(([k, v]) => !!v).map(([k, v]) => [k, !!v]))
  }

  set watching(value: Record<string, boolean>) {
    for (const [name, watching] of Object.entries(value)) {
      if(watching !== this.watching[name]) {
        this.toggleWatch(name, watching)
      }
    }
  }

  get widgetNames() {
    return Object.keys(this.packages).map(name => unscopePackageName(name))
  }

  get widgetPackageMap(): Record<string, Package> {
    return Object.fromEntries(Object.keys(this.packages).map(name => [unscopePackageName(name), this.packages[name]]))
  }
  
  async initialize(force=false) {
    if(this.apiBase) {
      return this.load()
    }
    this.initializing = true
    const rootExists = await this.FS.exists(await this.rootPackageJsonPath)
    const appDir = await this.appDir
    const appDirExists = rootExists || await this.FS.exists(appDir)
    try {
      if(!rootExists || force) {
        await (appDirExists && this.FS.rmdir(appDir))
        await this.FS.mkdir(appDir)
        await this.writeRootPackageJson()
        await this.pm("install", undefined, appDir)
      }

      await this.load()
      /*
      if(this.updateOnStartup) {
        await this.pm("update", undefined, appDir)
      }*/
    }
    catch(err) {
      console.error(err)
      if(await confirm("Error initializing WebWriter. Reset and try again?")) {
        await this.initialize(true)
      }
    }
    this.initializing = false
  }

  static get defaultRootPackage() {
    return new Package({
      name: "webwriter-root",
      version: appVersion,
      private: true,
      description: "Internal package to manage installed WebWriter packages"
    })
  }

  static get tsconfigJson() {
    return {
      compilerOptions: {
        target: "es2022",
        esModuleInterop: true
      }
    }
  }

  get initialFiles() {
    return {
      "package.json": JSON.stringify(PackageStore.defaultRootPackage, undefined, 2),
      "tsconfig.json": JSON.stringify(PackageStore.tsconfigJson, undefined, 2)
    }
  }

  private async readRootPackageJson() {
    if(!await this.FS.exists(await this.rootPackageJsonPath)) {
      return undefined
    }
    const json = JSON.parse(await this.FS.readFile(await this.rootPackageJsonPath) as string)
    return new Package(json) as Package & {localPaths: Record<string, string>}
  }

  private async writeRootPackageJson(pkg: Package = PackageStore.defaultRootPackage) {
    return this.FS.writeFile(await this.rootPackageJsonPath, JSON.stringify(pkg, undefined, 2))
  }

  async add(urlOrHandle: string | FileSystemDirectoryHandle, name?: string) {
    const id = typeof urlOrHandle === "string"? urlOrHandle: name!
    const pkg = Package.fromID(id)
    const matchingPkg = this.installed.find(match => pkg.name === match.name)
    const cancelled = matchingPkg && !confirm(`Installing ${id} requires uninstalling ${matchingPkg.id}. Do you want to continue?`)
    if(matchingPkg && cancelled) {
      return
    }
    else if(matchingPkg && !cancelled) {
      await new Promise(async r => this.pmQueue.push({command: "remove", parameters: [matchingPkg.id], cwd: await this.appDir, name: matchingPkg.id}, r))
    }

    if(typeof urlOrHandle === "string") {
      const url = urlOrHandle
      this.adding = {...this.adding, [name ?? url]: true}
      return this.pmQueue.push({command: "add", parameters: [url], cwd: await this.appDir, name})
    }
    else {
      const handle = urlOrHandle
      this.adding = {...this.adding, [name ?? handle.name]: true}
      return this.pmQueue.push({command: "add", parameters: [], handle, cwd: await this.appDir, name})
    }
  }

  async remove(name: string) {
    this.removing = {...this.removing, [name]: true}
    return this.pmQueue.push({command: "remove", parameters: [name], cwd: await this.appDir})
  }

  async update(name?: string) {
    this.updating = name
      ? {...this.updating, [name]: true}
      : Object.fromEntries(this.packagesList.filter(pkg => pkg.installed).map(pkg => [pkg.id, true]))
    return this.pmQueue.push({command: "update", parameters: name? [name, "--latest"]: ["--latest"], cwd: await this.appDir})
  }

  get packagesList() {
    return Object.values(this.packages)
  }
  
  private async writeH5Package(url: string | string[]): Promise<string | string[]> {
    if(Array.isArray(url)) {
      return Promise.all(url.map(u => this.writeH5Package(u) as Promise<string>))
    }
    const {href, pathname, hash} = new URL(url)
    const urlWithoutHash = href.split("#")[0]
    const packageName = pathname.split("/").filter(v => v).pop()?.replace(".git", "") as string
    const appDir = await this.Path.appDir()
    const dir = appDir + "h5_packages/" + packageName
    const ref = hash? hash.replace("#", ""): "master"
    await this.FS.mkdir(dir + "/.git")
    await this.FS.writeFile(dir + "/.git/config", "", "utf8")
    // yield call(clone, {fs, http, dir, url: urlWithoutHash, singleBranch: true, ref, depth: 1})
    const libString = await this.FS.readFile(dir + "/library.json", "utf8") as string
    const lib = JSON.parse(libString)
    const pkg = PackageStore.H5PtoPackageJson(packageName, lib)
    const packageJsonPath = await this.Path.join(dir, "package.json")
    const indexJsPath = await this.Path.join(dir, "index.js")
    this.FS.writeFile(packageJsonPath, JSON.stringify(pkg, undefined, 2), "utf8")
    this.FS.writeFile(indexJsPath, "export default null", "utf8")
    return dir
  }

  async updateLocalLinks(dependencies?: Record<string, string>) {
    if(dependencies) {
      for(const path of Object.values(dependencies)) {
        await this.pm("link", undefined, path)
      }
    }
    else {
      const pkg = await this.readRootPackageJson()
      if(pkg?.localPaths) {
        const deps = pkg?.dependencies ?? {}
        pkg.localPaths = filterObject(pkg.localPaths, k => k in deps)
        for(const path of Object.values(pkg.localPaths)) {
          await this.pm("link", undefined, path)
        }
        this.writeRootPackageJson(pkg)
      } 
    }
  }

  lastLoaded: number

  /** Reads local packages from disk, importing them, and/or fetches available packages from the configured registry.*/
  async load() {
    this.lastLoaded = Date.now()
    this.loading = true
    this.issues = {}
    if(!this.apiBase) {
      await this.updateLocalLinks()
    }
    
    let [installed, available] = await Promise.all([
      this.apiBase? []: this.fetchInstalled(),
      this.fetchAvailable()
    ])

    let final: Package[] = []
    if(!this.apiBase) {
      const importable = installed.filter(pkg => !this.getPackageIssues(pkg.id)?.length)
      const importableVersionMap = Object.fromEntries(importable.map(pkg => [pkg.name, pkg.id]))
      const importIDs = this.widgetImportIDs(importable)
      const newID = PackageStore.computeBundleID(importIDs, false, importable.some(pkg => pkg.localPath)? this.lastLoaded: undefined)
      if(newID !== this.bundleID) {
        try {
          const {bundleJS, bundleCSS, errors} = await PackageStore.readBundle(importIDs, this.bundle, this.Path, this.FS)
          this.bundleID = newID
          for(const err of errors) {
            this.appendPackageIssues(importableVersionMap[err.id as any], err)
            console.error(err.message)
          }
          this.bundleJS = bundleJS!
          this.bundleCSS = bundleCSS!;
          (this.onBundleChange ?? (() => null))(importable)
        }
        catch(rawErr) {
          throw rawErr
          this.appendManagementIssues(new BundleIssue(rawErr as string))
        }
      }
      for(const pkg of installed) {
        const aPkg = available.find(a => a.id === pkg.id)
        if(aPkg) {
          available = available.filter(a => a.name !== pkg.id)
        }
        const latest = aPkg?.version
        final.push(pkg.extend({latest, installed: true}))
      }
      final = final.concat(available.filter(pkg => !final.some(finalPkg => finalPkg.name === pkg.name)))
      this.packages = Object.fromEntries(final.map(pkg => [pkg.id, pkg]))
    }
    else {
      const localIds = this.installedPackages.filter(id => Package.fromID(id).version.prerelease.includes("local"))
      let local = (await Promise.all(localIds.map(id => fetch(new URL(id + "/package.json", this.apiBase)).then(resp => resp.json()))))
        .map(json => {
          const version = new SemVer(json.version)
          version.prerelease = [...version.prerelease, "local"]
          return new Package({...json, version}, {installed: true, localPath: "hidden"})
        })
      local = await Promise.all(local.map(async pkg => pkg.extend({members: await this.readPackageMembers(pkg)})))
      await this.updateLocalWatchIntervals(local)
      final = available.map(pkg => pkg.extend({installed: this.installedPackages.includes(pkg.id)})).sort((a, b) => Number(!!b.installed) - Number(!!a.installed))
      const snippetData = await this.getSnippet(undefined)
      const snippets = snippetData.map(snippet => {
        return new Package({name: `snippet-${parseInt(snippet.id)}`, version: "0.0.0-snippet", private: true})
      }).reverse()
      final = [...snippets, ...local, ...final]
      await this.updateImportMap()
      this.bundleID = PackageStore.computeBundleID(this.installedPackages, false, final.some(pkg => pkg.localPath)? this.lastLoaded: undefined);
      (this.onBundleChange ?? (() => null))(final.filter(pkg => pkg.installed))
      this.packages = Object.fromEntries(final.map(pkg => [pkg.id, pkg]))
    }
    this.searchIndex.removeAll()
    this.searchIndex.addAll(final)
    this.loading = false
  }

  get bundleJSURL() {
    const url = new URL("_bundles", this.apiBase)
    this.installed.forEach(pkg => url.searchParams.append("id", pkg.id))
    url.searchParams.append("pkg", "true")
    return url
  }

  get bundleCSSURL() {
    const url = new URL("_bundles", this.apiBase)
    this.installed.forEach(pkg => url.searchParams.append("id", pkg.id))
    url.searchParams.append("type", "css")
    url.searchParams.append("pkg", "true")
    return url
  }

  private async fetchAvailable() {
    let rawPkgs: any[] = []
    if(this.apiBase) {
      const resp = await fetch(new URL("_packages", this.apiBase))
      if(resp.ok) {
        rawPkgs = await resp.json()
      }
    }
    else {
      try {
        const {objects} = await this.search("keywords:webwriter-widget")
        rawPkgs = objects.map(obj => obj["package"])
      }
      catch(cause) {
        this.appendManagementIssues(new ServiceIssue("Could not run search", {cause}))
      }
    }
    const members = await Promise.all(rawPkgs.map(async pkg => this.readPackageMembers(pkg)))
    return rawPkgs.map((pkg, i) => {
      try {
        return new Package(pkg, {members: members[i]})
      }
      catch(err) {
        const parseIssues = JSON.parse((err as any)?.message)
        const errors = parseIssues.map((raw: any) => {
          let issueSection = pkg
          let key = undefined
          for(const part of raw.path) {
            key = part
            issueSection = issueSection[part]
          }
          const cause = (key? `"${key}": `: "") + JSON.stringify(issueSection, undefined, 2)
          const issue = new InstallIssue(raw.message, {cause})
          issue.stack = undefined
          return issue
        })
        this.appendPackageIssues(`${pkg.name}@${pkg.version}`, ...errors)
        return new Package({name: pkg.name, version: pkg.version})
      }
    }).filter(pkg => pkg)
  }

  private async fetchInstalled() {
    const appDir = await this.appDir;
    let pkgJsonPaths = {} as Record<string, string>, localPaths = {} as Record<string, string>
    try {
      const pkg = await this.readRootPackageJson()
      const dependencies = pkg?.dependencies ?? {}
      localPaths = pkg?.localPaths ?? {}
      pkgJsonPaths = Object.fromEntries(await Promise.all(Object.keys(dependencies).map(async k => [k, await this.Path.join(appDir, "node_modules", k, "package.json")])))
    }
    catch(cause) {
      this.appendManagementIssues(new ReadWriteIssue("Could not read installed package.json files", {cause}))
    }
    const pkgs = await Promise.all(Object.entries(pkgJsonPaths).map(([k, jsonPath]) => this.readPackage(jsonPath, localPaths[k])))
    return pkgs
  }

  private async validateInstalled(pkgs: Package[]) {
    // Warn for packages without exports
    // Warn for packages that register extra custom elements
  }

  private async readPackage(jsonPath: string, localPath?: string) {
    const pkgRootPath = jsonPath.slice(0, -("package.json".length))
    const pkgString = await this.FS.readFile(jsonPath) as string
    let pkgJson = {} as any
    try {
      pkgJson = JSON.parse(pkgString)
    }
    catch(cause) {
      const nameRegex = /"name":\s*".*"/g
      const versionRegex = /"version":\s*".*"/g
      const name = nameRegex.exec(pkgString)
      const version = versionRegex.exec(pkgString)
      const id = `${name}@${version}`
      // this.appendPackageIssues(id, cause as Error)
    }
    const members = await this.readPackageMembers(pkgJson, pkgRootPath)
    return new Package(pkgJson, {installed: true, watching: this.watching[pkgJson.id], localPath, members, lastLoaded: Date.now()})
  }

  private async readPackageMembers(pkg: Package, path?: string) {
    const exports = pkg.exports ?? {}
    const editingConfig = pkg?.editingConfig ?? {}

    const members = {} as Record<string, MemberSettings>
    for(const [rawName, p] of Object.entries(exports)) {
      const name = rawName.replace(/(\.html|\.\*|\.css)$/g, "")
      const isWidget = name.split("/").at(-2) === "widgets"
      const isSnippet = name.split("/").at(-2) === "snippets"
      const isTheme = name.split("/").at(-2) === "themes"
      if(isWidget || isSnippet || isTheme) {
        const memberSettings = editingConfig[name]
        let source: string | undefined, fullPath: string | undefined
        if((isSnippet || isTheme) && path) {
          try {
            fullPath = await this.Path.join(path, p as any)
          }
          catch(cause) {
            throw new ReadWriteIssue(`Could not join paths '${path}' and '${p}'`, {cause})
          }
          try {
            if(!this.apiBase) {
              source = await this.FS.readFile(fullPath) as string
            }
          }
          catch(cause) {
            // throw new ReadWriteIssue(`Could not read file ${fullPath}`, {cause})
          }
        }
        members[name] = {name, legacy: !rawName.endsWith(".*"), ...memberSettings, ...(source? {source}: undefined)}
      }
    }
    return members
  }

  /*
  private async readAnalysis(pkg: Package, path: string) {
    const relativeManifestPath = typeof pkg.customElements === "string"? pkg.customElements: undefined
    const cemPath = await this.Path.join(await this.appDir, "node_modules", ".bin", "cem")
    if(!relativeManifestPath) {
      const exports = pkg.exports ?? {}
      const widgetKeys = Object.keys(exports).filter(k => k.startsWith("./widgets/"))
      const globs = widgetKeys.map(k => `"${k}"`).join(" ")
      const webComponentLib = this.sniffWebComponentLibrary(pkg)
      const opts = [cemPath, "analyze", webComponentLib? `--${webComponentLib}`: "", `--globs ${globs}`]
      await this.pm("exec", opts, path)
    }
    const manifestPath = relativeManifestPath
      ? await this.Path.resolve(relativeManifestPath)
      : path + "custom-elements.json"
    const str = await this.FS.readFile(manifestPath, "utf8") as string
    return JSON.parse(str) as CustomElementsManifest
  }*/

  private sniffWebComponentLibrary(pkg: Package): undefined | "litelement" | "fast" | "stencil" | "catalyst" {
    const depNames = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {})
    ] 
    if(depNames.includes("lit")) {
      return "litelement"
    }
    else if(depNames.includes("@microsoft/fast-element")) {
      return "fast"
    }
    else if(depNames.includes("@stencil/core")) {
      return "stencil"
    }
    else if(depNames.includes("@github/catalyst")) {
      return "catalyst"
    }
    else {
      return undefined
    }
  }

  get installed() {
    return Object.values(this.packages).filter(pkg => pkg.installed)
  }

  get available() {
    return Object.values(this.packages).filter(pkg => !pkg.installed)
  }

  get local() {
    return Object.values(this.packages).filter(pkg => pkg.localPath)
  }

  get localSnippets() {
    return Object.values(this.packages).filter(pkg => pkg.isSnippet)
  }

  getPackageMembers(id: string, filter?: "widgets" | "snippets" | "themes") {
    const pkg = this.packages[id]
    const members = {} as any
    for(const [memberName, member] of Object.entries(pkg?.members ?? {})) {
      const is = {
        widgets: memberName.startsWith("./widgets/"),
        snippets: memberName.startsWith("./snippets/"),
        themes: memberName.startsWith("./themes/") 
      }
      const defaultLabel = memberName.replace(/\.\/\w+\//, "").split("-").slice(is.widgets? 1: 0).map(capitalizeWord).join(" ");
      if(!filter || is[filter]) {
        members[memberName] = {...member, name: memberName, label: {_: defaultLabel, ...member.label}}
      }
    }
    return members
  }

  get widgets() {
    return Object.fromEntries(Object.keys(this.packages).map(id => [id, this.getPackageMembers(id, "widgets")]))
    // return Object.fromEntries(Object.entries(this.members).map(([k, v]) => [k, filterObject(v, vk => vk.startsWith("./widgets/"))]))
  }

  get snippets() {
    return Object.fromEntries(Object.keys(this.packages).map(id => [id, this.getPackageMembers(id, "snippets")]))
    // return Object.fromEntries(Object.entries(this.members).map(([k, v]) => [k, filterObject(v, vk => vk.startsWith("./snippets/"))]))
  }

  get themes() {
    return Object.fromEntries(Object.keys(this.packages).map(id => [id, this.getPackageMembers(id, "themes")]))
    // return Object.fromEntries(Object.entries(this.members).map(([k, v]) => [k, filterObject(v, vk => vk.startsWith("./themes/"))]))
  }

  get allThemes() {
    const allThemes = {...themes}
    for (const [id, map] of Object.entries(this.themes)) {
      for (const [relativeName, themeSettings] of Object.entries(map)) {
        (allThemes as any)[`${id}${relativeName.slice(1)}`] = themeSettings
      }
    }
    return allThemes
  }

  get installedWidgetUrls() {
    return this.apiBase? this.installed.flatMap(pkg => Object.keys(pkg?.widgets ?? {}).flatMap(k => new URL(pkg.id + k.slice(1), this.apiBase).href)): []
  }

  get widgetTagNames() {
    return Object.entries(filterObject(this.widgets, k => this.installed.some(pkg => pkg.id === k)))
      .flatMap(([pkgID, widgetConfig]) => Object.keys(widgetConfig))
      .map(k => k.replace("./widgets/", ""))
  }

  widgetImportIDs(pkgs: Package[]) {
    return pkgs.flatMap(pkg => {
      const widgets = pkg?.widgets ?? {}
      return Object.keys(widgets).map(k => pkg.id + k.slice(1) + ".js")
    })
  }

  /** Toggles watching on a single named package.*/
  async toggleWatch(name: string, forceValue?: boolean) {
    await this.initialized
    if(this.apiBase) {
      return
    }
    const pkg = this.packages[name]
    if(!pkg) {
      return 
    }
    const watching = forceValue ?? !pkg?.watching
    if(watching && pkg?.localPath) {
      this.unwatchCallbacks[name] = await this.watch(pkg.localPath, async (e) => {
        if(!this.loading) {
          this.load()
        }
      }, {recursive: true})
    }
    else {
      (this.unwatchCallbacks[name] ?? (() => {}))()
      delete this.unwatchCallbacks[name]
    }
    this.packages = {...this.packages, [name]: pkg.extend({watching})}
  }

  /** Open the entrypoint file of the package.*/
  async open(name: string) {
    if(!(name in this.packages)) {
      throw Error(`Package ${name} not found`)
    }
    const pkg = this.packages[name]
    if(pkg.main || pkg.browser) {
      const main = pkg.main ?? pkg.browser
      const appDir = await this.Path.appDir()
      const path = await this.Path.join(appDir, "node_modules", name, main!)
      return this.Shell.open(path)
    }
    else {
      throw Error(`No main file configured for package ${name}`)
    }
  }

  async resolveRelativeLocalPath(path: string, handle: FileSystemDirectoryHandle) {
    const parts = path.split("/").slice(1)
    let directory = handle
    let file: File
    for(const [i, part] of parts.entries()) {
      if(i === parts.length - 1) {
        const fileHandle = await directory.getFileHandle(part)
        file = await fileHandle.getFile()
      }
      else {
        directory = await directory.getDirectoryHandle(part)
      }
    }
    return file!
  }

  async getLocalHandle(id: string): Promise<FileSystemDirectoryHandle> {
    const db = indexedDB.open("webwriter")
    await new Promise(r => db.addEventListener("success", r))
    const tx = db.result.transaction("handles", "readwrite")
    const store = tx.objectStore("handles")
    const req = store.get(id)
    return new Promise(r => req.addEventListener("success", async () => {
      db.result.close()
      r(req.result.handle)
    }))
  }

  /** Reads a local package directory, returning the package config. */
  async readLocal(pathOrHandle: string | FileSystemDirectoryHandle) {
    let pkgString: string
    if(typeof pathOrHandle === "string") {
      const resolvedPath = await this.Path.resolve(pathOrHandle)
      const pkgJsonPath = await this.Path.join(resolvedPath, "package.json")
      const exists = await this.FS.exists(pkgJsonPath)
      if(!exists) {
        throw Error("No package found under " + pkgJsonPath)
      }
      pkgString = await this.FS.readFile(pkgJsonPath) as string
    }
    else {
      let pkgJsonHandle
      try {
        pkgJsonHandle = await pathOrHandle.getFileHandle("package.json")
      }
      catch(err) {
        throw Error("No package found under " + pathOrHandle.name)
      }
      const file = await pkgJsonHandle.getFile()
      pkgString = await file.text()
    }
    let pkg
    try {
      pkg = new Package(JSON.parse(pkgString!))
    }
    catch(cause) {
      throw new PackageJsonIssue(`Error parsing package.json: ${cause}`, {cause})
    }
    return pkg
  }

  watchLocalIntervals: Record<string, number> = {}

  async updateLocalWatchIntervals(pkgs: Package[], ms=250) {
    // Each interval, poll package.json AND all exports (including pairs of .js & .css):
    //   If any file is newer than the last load time, trigger a reload (unless we are already reloading)
    const oldNames = Object.keys(this.watchLocalIntervals)
    const newNames = pkgs.map(pkg => pkg.name)
    const toRemove = oldNames.filter(name => !newNames.includes(name))
    const toAdd = newNames.filter(id => !oldNames.includes(id))
    for(const name of toRemove) {
      clearInterval(this.watchLocalIntervals[name])
    }
    for(const name of toAdd) {
      const handle = await this.getLocalHandle(name)
      this.watchLocalIntervals[name] = setInterval(async () => {
        const pkgJsonFile = await (await handle.getFileHandle("package.json")).getFile()
        if(pkgJsonFile.lastModified >= this.lastLoaded) {
          return this.load()
        } 
        let pkgString = await pkgJsonFile.text()
        let pkg
        try {
          pkg = new Package(JSON.parse(pkgString!))
        }
        catch(cause) {
          return
        }
        const exports = pkg?.exports
        const exportPaths = Object.keys(exports as any)
          .filter(k => k.startsWith("./widgets/") || k.startsWith("./snippets/") || k.startsWith("./themes/"))
          .map(k => typeof (exports as any)[k] !== "string"? (exports as any)[k]?.default as string: (exports as any)[k] as string)
          .flatMap(k => !k.endsWith(".*")? [k]: [k.slice(0, -2) + ".js", k.slice(0, -2) + ".css"])
        const exportedFiles = await Promise.all(exportPaths.map(path => this.resolveRelativeLocalPath(path, handle)))
        if(exportedFiles.some(file => file.lastModified >= this.lastLoaded)) {
          return this.load()
        }
  
      }, ms) as unknown as number
    }
  }

  /** Write a given package to a directory, creating files as neccessary. If `force` is false, abort if existing files are found. */
  async writeLocal(path: string, pkg: Package, {extraFiles = {} as Record<string, string>, mergePackage=false, overwrite=false, preset="none", generateLicense=false}) {
    const resolvedPath = await this.Path.resolve(path)

    let allExtraFiles = {...extraFiles}
    if(preset && preset in presets) {
      allExtraFiles = {...allExtraFiles, ...(presets as any)[String(preset)](pkg)}
    }
    if(generateLicense && String(pkg.license) in licenses) {
      allExtraFiles = {...allExtraFiles, ...(licenses as any)[String(pkg.license)](pkg)}
    }
    await Promise.all(Object.keys(allExtraFiles).map(async fileName => {
      const extraPath  = await this.Path.join(resolvedPath, fileName)
      const extraPathDir = await this.Path.dirname(extraPath)
      const extraExists = await this.FS.exists(extraPath)
      const extraDirExists = await this.FS.exists(extraPathDir)
      if(extraExists && !overwrite) {
        throw Error("Existing extra file found under " + extraPath)
      }
      if(!extraDirExists) {
        await this.FS.mkdir(extraPathDir)
      }
      return this.FS.writeFile(extraPath, allExtraFiles[fileName])
    }))
    const pkgJsonPath = await this.Path.join(resolvedPath, "package.json")
    const exists = await this.FS.exists(pkgJsonPath)
    if(exists && !mergePackage) {
      throw Error("Existing package.json file found under " + pkgJsonPath)
    }
    const existingPkg = exists? new Package(JSON.parse(await this.FS.readFile(pkgJsonPath) as string)): null
    const newPkg = existingPkg? existingPkg.extend(pkg): pkg
    await this.FS.writeFile(pkgJsonPath, JSON.stringify(newPkg, undefined, 2))
  }

  /** Uses the provided system shell to open the app directory. */
  async viewAppDir() {
    const appDir = await this.Path.appDir()
    return this.Shell.open(appDir)
  }

  async getSnippet<T extends string | undefined>(id?: T) {
    const url = new URL(id? `_snippets/${id}`: "_snippets", this.apiBase)
    const response = await fetch(url)
    return response.json() as Promise<T extends undefined? Snippet[]: Snippet>
  }

  async addSnippet(snippet: Snippet) {
    const url = new URL("_snippets", this.apiBase)
    const resp = await fetch(url, {body: new Blob([JSON.stringify(snippet)]), method: "POST"})
    return this.load()
  }

  async putSnippet(id: string, snippet: Snippet) {
    const url = new URL(`_snippets/${id}`, this.apiBase)
    await fetch(url, {body: new Blob([JSON.stringify(snippet)]), method: "PUT"})
    return this.load()
  }

  async removeSnippet(id: string) {
    const url = new URL(`_snippets/${id}`, this.apiBase)
    await fetch(url, {method: "DELETE"})
    return this.load()
  }
}