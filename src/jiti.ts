import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { Module, builtinModules } from "module";
import { performance } from "perf_hooks";
import { platform } from "os";
import vm from "vm";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join, basename, extname } from "pathe";
import escapeStringRegexp from "escape-string-regexp";
import createRequire from "create-require";
import { normalizeAliases, resolveAlias } from "pathe/utils";
import { addHook } from "pirates";
import { hasESMSyntax, interopDefault, resolvePathSync } from "mlly";
import {
  getCacheDir,
  isDir,
  isWritable,
  md5,
  detectLegacySyntax,
  readNearestPackageJSON,
} from "./utils";
import { TransformOptions, JITIOptions } from "./types";
import { resolveJitiOptions } from "./options";

export type { JITIOptions, TransformOptions } from "./types";

const isWindows = platform() === "win32";

type Require = typeof require;
type Module = typeof module;

type ModuleCache = Record<string, Module>;

export type EvalModuleOptions = Partial<{
  id: string;
  filename: string;
  ext: string;
  cache: ModuleCache;
}>;

export interface JITI extends Require {
  transform: (opts: TransformOptions) => string;
  register: () => () => void;
  evalModule: (source: string, options?: EvalModuleOptions) => unknown;
  /** @experimental Behavior of `jiti.import` might change in the future. */
  import: (id: string) => Promise<unknown>;
}

const JS_EXT_RE = /\.(c|m)?j(sx?)$/;
const TS_EXT_RE = /\.(c|m)?t(sx?)$/;

export default function createJITI(
  _filename: string,
  userOptions: JITIOptions = {},
  parentModule?: Module,
  parentCache?: ModuleCache,
): JITI {
  const opts = resolveJitiOptions(userOptions);

  // Normalize aliases (and disable if non given)
  const alias =
    opts.alias && Object.keys(opts.alias).length > 0
      ? normalizeAliases(opts.alias || {})
      : null;

  // List of modules to force transform or native
  const nativeModules = ["typescript", "jiti", ...(opts.nativeModules || [])];
  const transformModules = [...(opts.transformModules || [])];
  const isNativeRe = new RegExp(
    `node_modules/(${nativeModules
      .map((m) => escapeStringRegexp(m))
      .join("|")})/`,
  );
  const isTransformRe = new RegExp(
    `node_modules/(${transformModules
      .map((m) => escapeStringRegexp(m))
      .join("|")})/`,
  );

  function debug(...args: string[]) {
    if (opts.debug) {
      // eslint-disable-next-line no-console
      console.log("[jiti]", ...args);
    }
  }

  // If filename is dir, createRequire goes with parent directory, so we need fakepath
  if (!_filename) {
    _filename = process.cwd();
  }
  if (isDir(_filename)) {
    _filename = join(_filename, "index.js");
  }

  if (opts.cache === true) {
    opts.cache = getCacheDir();
  }
  if (opts.cache) {
    try {
      mkdirSync(opts.cache as string, { recursive: true });
      if (!isWritable(opts.cache)) {
        throw new Error("directory is not writable");
      }
    } catch (error: any) {
      debug("Error creating cache directory at ", opts.cache, error);
      opts.cache = false;
    }
  }

  const nativeRequire = createRequire(
    isWindows
      ? _filename.replace(/\//g, "\\") // Import maps does not work with normalized paths!
      : _filename,
  );

  const tryResolve = (id: string, options?: { paths?: string[] }) => {
    try {
      return nativeRequire.resolve(id, options);
    } catch {}
  };

  const _url = pathToFileURL(_filename);
  const _additionalExts = [...(opts.extensions as string[])].filter(
    (ext) => ext !== ".js",
  );
  const _resolve = (id: string, options?: { paths?: string[] }) => {
    let resolved, err;

    // Resolve alias
    if (alias) {
      id = resolveAlias(id, alias);
    }

    // Try ESM resolve
    if (opts.esmResolve) {
      const conditionSets = [
        ["node", "require"],
        ["node", "import"],
      ];
      for (const conditions of conditionSets) {
        try {
          resolved = resolvePathSync(id, {
            url: _url,
            conditions,
            extensions: opts.extensions,
          });
        } catch (error) {
          err = error;
        }
        if (resolved) {
          return resolved;
        }
      }
    }

    // Try native require resolve
    try {
      return nativeRequire.resolve(id, options);
    } catch (error) {
      err = error;
    }
    for (const ext of _additionalExts) {
      resolved =
        tryResolve(id + ext, options) ||
        tryResolve(id + "/index" + ext, options);
      if (resolved) {
        return resolved;
      }
      // Try resolving .ts files with .js extension
      if (TS_EXT_RE.test(parentModule?.filename || "")) {
        resolved = tryResolve(id.replace(JS_EXT_RE, ".$1t$2"), options);
        if (resolved) {
          return resolved;
        }
      }
    }
    throw err;
  };
  _resolve.paths = nativeRequire.resolve.paths;

  function getCache(
    filename: string | undefined,
    source: string,
    get: () => string,
  ): string {
    if (!opts.cache || !filename) {
      return get();
    }

    // Calculate source hash
    const sourceHash = ` /* v${opts.cacheVersion}-${md5(source, 16)} */`;

    // Check cache file
    const filebase = basename(dirname(filename)) + "-" + basename(filename);
    const cacheFile = join(
      opts.cache as string,
      filebase + "." + md5(filename) + ".js",
    );

    if (existsSync(cacheFile)) {
      const cacheSource = readFileSync(cacheFile, "utf8");
      if (cacheSource.endsWith(sourceHash)) {
        debug("[cache hit]", filename, "~>", cacheFile);
        return cacheSource;
      }
    }

    debug("[cache miss]", filename);
    const result = get();

    if (!result.includes("__JITI_ERROR__")) {
      writeFileSync(cacheFile, result + sourceHash, "utf8");
    }

    return result;
  }

  function transform(topts: any): string {
    let code = getCache(topts.filename, topts.source, () => {
      const res = opts.transform!({
        legacy: opts.legacy,
        ...opts.transformOptions,
        babel: {
          ...(opts.sourceMaps
            ? {
                sourceFileName: topts.filename,
                sourceMaps: "inline",
              }
            : {}),
          ...opts.transformOptions?.babel,
        },
        ...topts,
      });
      if (res.error && opts.debug) {
        debug(res.error);
      }
      return res.code;
    });
    if (code.startsWith("#!")) {
      code = "// " + code;
    }
    return code;
  }

  function _interopDefault(mod: any) {
    return opts.interopDefault ? interopDefault(mod) : mod;
  }

  function jiti(id: string) {
    const cache = parentCache || {};

    // Check for node: and file: protocol
    if (id.startsWith("node:")) {
      id = id.slice(5);
    } else if (id.startsWith("file:")) {
      id = fileURLToPath(id);
    }

    // Check for builtin node module like fs
    if (builtinModules.includes(id) || id === ".pnp.js" /* #24 */) {
      return nativeRequire(id);
    }

    // Experimental Bun support
    if (opts.experimentalBun && !opts.transformOptions) {
      try {
        debug(`[bun] [native] ${id}`);
        const _mod = nativeRequire(id);
        if (opts.requireCache === false) {
          delete nativeRequire.cache[id];
        }
        return _interopDefault(_mod);
      } catch (error: any) {
        debug(`[bun] Using fallback for ${id} because of an error:`, error);
      }
    }

    // Resolve path
    const filename = _resolve(id);
    const ext = extname(filename);

    // Check for .json modules
    if (ext === ".json") {
      debug("[json]", filename);
      const jsonModule = nativeRequire(id);
      Object.defineProperty(jsonModule, "default", { value: jsonModule });
      return jsonModule;
    }

    // Unknown format
    if (ext && !opts.extensions!.includes(ext)) {
      debug("[unknown]", filename);
      return nativeRequire(id);
    }

    // Force native modules
    if (isNativeRe.test(filename)) {
      debug("[native]", filename);
      return nativeRequire(id);
    }

    // Check for CJS cache
    if (cache[filename]) {
      return _interopDefault(cache[filename]?.exports);
    }
    if (opts.requireCache && nativeRequire.cache[filename]) {
      return _interopDefault(nativeRequire.cache[filename]?.exports);
    }

    // Read source
    const source = readFileSync(filename, "utf8");

    // Evaluate module
    return evalModule(source, { id, filename, ext, cache });
  }

  function evalModule(source: string, evalOptions: EvalModuleOptions = {}) {
    // Resolve options
    const id =
      evalOptions.id ||
      (evalOptions.filename
        ? basename(evalOptions.filename)
        : `_jitiEval.${evalOptions.ext || ".js"}`);
    const filename = evalOptions.filename || _resolve(id);
    const ext = evalOptions.ext || extname(filename);
    const cache = (evalOptions.cache || parentCache || {}) as ModuleCache;

    // Transpile
    const isTypescript = ext === ".ts" || ext === ".mts" || ext === ".cts";
    const isNativeModule =
      ext === ".mjs" ||
      (ext === ".js" && readNearestPackageJSON(filename)?.type === "module");
    const isCommonJS = ext === ".cjs";
    const needsTranspile =
      !isCommonJS &&
      (isTypescript ||
        isNativeModule ||
        isTransformRe.test(filename) ||
        hasESMSyntax(source) ||
        (opts.legacy && detectLegacySyntax(source)));

    const start = performance.now();
    if (needsTranspile) {
      source = transform({ filename, source, ts: isTypescript });
      const time = Math.round((performance.now() - start) * 1000) / 1000;
      debug(
        `[transpile]${isNativeModule ? " [esm]" : ""}`,
        filename,
        `(${time}ms)`,
      );
    } else {
      try {
        debug("[native]", filename);
        return _interopDefault(nativeRequire(id));
      } catch (error: any) {
        debug("Native require error:", error);
        debug("[fallback]", filename);
        source = transform({ filename, source, ts: isTypescript });
      }
    }

    // Compile module
    const mod = new Module(filename);
    mod.filename = filename;
    if (parentModule) {
      mod.parent = parentModule;
      if (
        Array.isArray(parentModule.children) &&
        !parentModule.children.includes(mod)
      ) {
        parentModule.children.push(mod);
      }
    }

    mod.require = createJITI(filename, opts, mod, cache);

    // @ts-ignore
    mod.path = dirname(filename);

    // @ts-ignore
    mod.paths = Module._nodeModulePaths(mod.path);

    // Set CJS cache before eval
    cache[filename] = mod;
    if (opts.requireCache) {
      nativeRequire.cache[filename] = mod;
    }

    // Compile wrapped script
    let compiled;
    try {
      // @ts-ignore
      // mod._compile wraps require and require.resolve to global function
      compiled = vm.runInThisContext(Module.wrap(source), {
        filename,
        lineOffset: 0,
        displayErrors: false,
      });
    } catch (error: any) {
      if (opts.requireCache) {
        delete nativeRequire.cache[filename];
      }
      opts.onError!(error);
    }

    // Evaluate module
    try {
      compiled(
        mod.exports,
        mod.require,
        mod,
        mod.filename,
        dirname(mod.filename),
      );
    } catch (error: any) {
      if (opts.requireCache) {
        delete nativeRequire.cache[filename];
      }
      opts.onError!(error);
    }

    // Check for parse errors
    if (mod.exports && mod.exports.__JITI_ERROR__) {
      const { filename, line, column, code, message } =
        mod.exports.__JITI_ERROR__;
      const loc = `${filename}:${line}:${column}`;
      const err = new Error(`${code}: ${message} \n ${loc}`);
      Error.captureStackTrace(err, jiti);
      opts.onError!(err);
    }

    // Set as loaded
    mod.loaded = true;

    // interopDefault
    const _exports = _interopDefault(mod.exports);

    // Return exports
    return _exports;
  }

  function register() {
    return addHook(
      (source: string, filename: string) =>
        jiti.transform({ source, filename, ts: !!/\.[cm]?ts$/.test(filename) }),
      { exts: opts.extensions },
    );
  }

  jiti.resolve = _resolve;
  jiti.cache = opts.requireCache ? nativeRequire.cache : {};
  jiti.extensions = nativeRequire.extensions;
  jiti.main = nativeRequire.main;
  jiti.transform = transform;
  jiti.register = register;
  jiti.evalModule = evalModule;
  jiti.import = async (id: string) => await jiti(id);

  return jiti;
}
