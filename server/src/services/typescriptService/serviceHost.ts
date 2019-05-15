import * as path from 'path';
import * as ts from 'typescript';
import Uri from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-types';
import * as parseGitIgnore from 'parse-gitignore';

import { LanguageModelCache } from '../../embeddedSupport/languageModelCache';
import { createUpdater, parseVueScript } from './preprocess';
import { getFileFsPath, getFilePath, normalizeFileNameToFsPath } from '../../utils/paths';
import * as bridge from './bridge';
import { T_TypeScript } from '../../services/dependencyService';
import { getVueSys } from './vueSys';
import { TemplateSourceMap, stringifySourceMapNodes } from './sourceMap';
import { isVirtualVueTemplateFile, isVueFile } from './util';
import { logger } from '../../log';

const NEWLINE = process.platform === 'win32' ? '\r\n' : '\n';

function patchTS(tsModule: T_TypeScript) {
  // Patch typescript functions to insert `import Vue from 'vue'` and `new Vue` around export default.
  // NOTE: this is a global hack that all ts instances after is changed
  const { createLanguageServiceSourceFile, updateLanguageServiceSourceFile } = createUpdater(tsModule);
  (tsModule as any).createLanguageServiceSourceFile = createLanguageServiceSourceFile;
  (tsModule as any).updateLanguageServiceSourceFile = updateLanguageServiceSourceFile;
}

function getDefaultCompilerOptions(tsModule: T_TypeScript) {
  const defaultCompilerOptions: ts.CompilerOptions = {
    allowNonTsExtensions: true,
    allowJs: true,
    lib: ['lib.dom.d.ts', 'lib.es2017.d.ts'],
    target: tsModule.ScriptTarget.Latest,
    moduleResolution: tsModule.ModuleResolutionKind.NodeJs,
    module: tsModule.ModuleKind.CommonJS,
    jsx: tsModule.JsxEmit.Preserve,
    allowSyntheticDefaultImports: true,
    experimentalDecorators: true
  };

  return defaultCompilerOptions;
}

export const templateSourceMap: TemplateSourceMap = {};

export interface IServiceHost {
  queryVirtualFileInfo(fileName: string, currFileText: string): { source: string; sourceMapNodesString: string };
  updateCurrentVirtualVueTextDocument(
    doc: TextDocument
  ): {
    templateService: ts.LanguageService;
    templateSourceMap: TemplateSourceMap;
  };
  updateCurrentVueTextDocument(
    doc: TextDocument
  ): {
    service: ts.LanguageService;
    scriptDoc: TextDocument;
  };
  updateExternalDocument(filePath: string): void;
  dispose(): void;
}

/**
 * Manges 4 set of files
 *
 * - `vue` files in workspace
 * - `js/ts` files in workspace
 * - `vue` files in `node_modules`
 * - `js/ts` files in `node_modules`
 */
export function getServiceHost(
  tsModule: T_TypeScript,
  workspacePath: string,
  updatedScriptRegionDocuments: LanguageModelCache<TextDocument>
): IServiceHost {
  patchTS(tsModule);
  const vueSys = getVueSys(tsModule);

  let currentScriptDoc: TextDocument;

  const versions = new Map<string, number>();
  const localScriptRegionDocuments = new Map<string, TextDocument>();
  const nodeModuleSnapshots = new Map<string, ts.IScriptSnapshot>();
  const projectFileSnapshots = new Map<string, ts.IScriptSnapshot>();
  const notLoadedVueFileSnapshots = new Map<string, ts.IScriptSnapshot>();
  const notLoadedVueFileScriptKind = new Map<string, ts.ScriptKind>();
  const vueFileScriptExtensions = new Map<string, ts.Extension>();
  const tsMRcache = tsModule.createModuleResolutionCache(workspacePath, s => s);
  const resolvedModuleCache = new Map<string, ts.ResolvedModuleFull>();

  /**
   * For the case when requiring .vue file from another .vue file
   * The file wouldn't be loaded, so populate all caches manually for it
   */
  function updateVueCache(fileName: string) {
    if (!versions.get(fileName)) {
      versions.set(fileName, 0);
    }
    if (!notLoadedVueFileSnapshots.get(fileName)) {
      const fileText = tsModule.sys.readFile(fileName) || '';
      const snapshot: ts.IScriptSnapshot = {
        getText: (start, end) => fileText.substring(start, end),
        getLength: () => fileText.length,
        getChangeRange: () => void 0
      };
      notLoadedVueFileSnapshots.set(fileName, snapshot);
    }
  }

  const parsedConfig = getParsedConfig(tsModule, workspacePath);
  /**
   * Only js/ts files in local project
   */
  const initialProjectFiles = parsedConfig.fileNames;
  logger.logDebug(
    `Initializing ServiceHost with ${initialProjectFiles.length} files: ${JSON.stringify(initialProjectFiles)}`
  );
  const scriptFileNameSet = new Set(initialProjectFiles);

  const isOldVersion = inferIsUsingOldVueVersion(tsModule, workspacePath);
  const compilerOptions = {
    ...getDefaultCompilerOptions(tsModule),
    ...parsedConfig.options
  };
  compilerOptions.allowNonTsExtensions = true;

  function queryVirtualFileInfo(
    fileName: string,
    currFileText: string
  ): { source: string; sourceMapNodesString: string } {
    const program = templateLanguageService.getProgram();
    if (program) {
      const tsVirtualFile = program.getSourceFile(fileName + '.template');
      if (tsVirtualFile) {
        return {
          source: tsVirtualFile.getText(),
          sourceMapNodesString: stringifySourceMapNodes(
            templateSourceMap[fileName],
            currFileText,
            tsVirtualFile.getText()
          )
        };
      }
    }

    return {
      source: '',
      sourceMapNodesString: ''
    };
  }

  function updateCurrentVirtualVueTextDocument(doc: TextDocument) {
    const fileFsPath = getFileFsPath(doc.uri);
    const filePath = getFilePath(doc.uri);
    // When file is not in language service, add it
    if (!localScriptRegionDocuments.has(fileFsPath)) {
      if (fileFsPath.endsWith('.vue') || fileFsPath.endsWith('.vue.template')) {
        scriptFileNameSet.add(filePath);
      }
    }

    if (isVirtualVueTemplateFile(fileFsPath)) {
      localScriptRegionDocuments.set(fileFsPath, doc);
      versions.set(fileFsPath, (versions.get(fileFsPath) || 0) + 1);
    }

    return {
      templateService: templateLanguageService,
      templateSourceMap
    };
  }

  function updateCurrentVueTextDocument(doc: TextDocument) {
    const fileFsPath = getFileFsPath(doc.uri);
    const filePath = getFilePath(doc.uri);
    // When file is not in language service, add it
    if (!localScriptRegionDocuments.has(fileFsPath)) {
      if (fileFsPath.endsWith('.vue') || fileFsPath.endsWith('.vue.template')) {
        scriptFileNameSet.add(filePath);
      }
    }

    if (!currentScriptDoc || doc.uri !== currentScriptDoc.uri || doc.version !== currentScriptDoc.version) {
      currentScriptDoc = updatedScriptRegionDocuments.refreshAndGet(doc)!;
      const localLastDoc = localScriptRegionDocuments.get(fileFsPath);
      if (localLastDoc && currentScriptDoc.languageId !== localLastDoc.languageId) {
        // if languageId changed, restart the language service; it can't handle file type changes
        jsLanguageService.dispose();
        jsLanguageService = tsModule.createLanguageService(jsHost);
      }
      localScriptRegionDocuments.set(fileFsPath, currentScriptDoc);
      vueFileScriptExtensions.set(
        fileFsPath,
        currentScriptDoc.languageId === 'javasccript' ? ts.Extension.Js : ts.Extension.Ts
      );
      versions.set(fileFsPath, (versions.get(fileFsPath) || 0) + 1);
    }
    return {
      service: jsLanguageService,
      scriptDoc: currentScriptDoc
    };
  }

  // External Documents: JS/TS, non Vue documents
  function updateExternalDocument(fileFsPath: string) {
    const ver = versions.get(fileFsPath) || 0;
    versions.set(fileFsPath, ver + 1);

    // Clear cache so we read the js/ts file from file system again
    if (projectFileSnapshots.has(fileFsPath)) {
      projectFileSnapshots.delete(fileFsPath);
    }
  }

  function createLanguageServiceHost(options: ts.CompilerOptions): ts.LanguageServiceHost {
    return {
      getCompilationSettings: () => options,
      getScriptFileNames: () => Array.from(scriptFileNameSet),
      getScriptVersion(fileName) {
        if (fileName.includes('node_modules')) {
          return '0';
        }

        if (fileName === bridge.fileName) {
          return '0';
        }

        const normalizedFileFsPath = normalizeFileNameToFsPath(fileName);
        const version = versions.get(normalizedFileFsPath);
        return version ? version.toString() : '0';
      },
      getScriptKind(fileName) {
        if (fileName.includes('node_modules')) {
          return (tsModule as any).getScriptKindFromFileName(fileName);
        }

        if (isVueFile(fileName)) {
          const uri = Uri.file(fileName);
          fileName = uri.fsPath;
          const doc = localScriptRegionDocuments.get(fileName);
          if (doc) {
            return getScriptKind(tsModule, doc.languageId);
          } else {
            if (notLoadedVueFileScriptKind.has(fileName)) {
              return notLoadedVueFileScriptKind.get(fileName);
            }
            const rawDoc = updatedScriptRegionDocuments.refreshAndGet(
              TextDocument.create(uri.toString(), 'vue', 0, tsModule.sys.readFile(fileName) || '')
            );

            const result = getScriptKind(tsModule, rawDoc.languageId);
            notLoadedVueFileScriptKind.set(fileName, result);
            return result;
          }
        } else if (isVirtualVueTemplateFile(fileName)) {
          return tsModule.ScriptKind.JS;
        } else {
          if (fileName === bridge.fileName) {
            return tsModule.ScriptKind.TS;
          }
          // NOTE: Typescript 2.3 should export getScriptKindFromFileName. Then this cast should be removed.
          return (tsModule as any).getScriptKindFromFileName(fileName);
        }
      },

      getDirectories: vueSys.getDirectories,
      directoryExists: vueSys.directoryExists,
      fileExists: vueSys.fileExists,
      readFile: vueSys.readFile,
      readDirectory(
        path: string,
        extensions?: ReadonlyArray<string>,
        exclude?: ReadonlyArray<string>,
        include?: ReadonlyArray<string>,
        depth?: number
      ): string[] {
        const allExtensions = extensions ? extensions.concat(['.vue']) : extensions;
        return vueSys.readDirectory(path, allExtensions, exclude, include, depth);
      },

      resolveModuleNames(moduleNames: string[], containingFile: string): ts.ResolvedModuleFull[] {
        logger.logDebug(`resolveModuleNames in ${containingFile} for ${moduleNames.toString()}`);

        // in the normal case, delegate to ts.resolveModuleName
        // in the relative-imported.vue case, manually build a resolved filename
        return moduleNames.map(name => {
          if (name === bridge.moduleName) {
            return {
              resolvedFileName: bridge.fileName,
              extension: tsModule.Extension.Ts
            };
          }

          // ts.ModuleResolution handles cache in this case
          if (!isVueFile(name)) {
            return tsModule.resolveModuleName(name, containingFile, options, tsModule.sys, tsMRcache).resolvedModule;
          }

          // Cache since manually calculating this is expensive.
          if (resolvedModuleCache.has(`${containingFile}#${name}`)) {
            return resolvedModuleCache.get(`${containingFile}#${name}`);
          }

          const resolved = tsModule.resolveModuleName(name, containingFile, options, vueSys, tsMRcache).resolvedModule;
          if (!resolved) {
            return undefined as any;
          }
          if (!resolved.resolvedFileName.endsWith('.vue.ts')) {
            return resolved;
          }

          const resolvedFileName = resolved.resolvedFileName.slice(0, -'.ts'.length);

          /**
           * The resolved .vue.ts file will always have wrong suffix
           * Read from cache or run the expensive FS read and cache the result
           */
          let extension = vueFileScriptExtensions.get(resolvedFileName);
          if (!extension) {
            extension = expensiveGetScriptKind(resolvedFileName);
            vueFileScriptExtensions.set(resolvedFileName, extension);
          }

          const result = { resolvedFileName, extension };
          resolvedModuleCache.set(`${containingFile}#${name}`, result);

          // The referenced .vue file is not loaded yet
          if (!versions.has(resolvedFileName) || !notLoadedVueFileSnapshots.has(resolvedFileName)) {
            updateVueCache(resolvedFileName);
          }

          return result;
        });

        function expensiveGetScriptKind(resolvedFileName: string) {
          const uri = Uri.file(resolvedFileName);
          let doc = localScriptRegionDocuments.get(resolvedFileName);
          // Vue file not loaded yet
          if (!doc) {
            doc = updatedScriptRegionDocuments.refreshAndGet(
              TextDocument.create(uri.toString(), 'vue', 0, tsModule.sys.readFile(resolvedFileName) || '')
            );
          }

          const extension =
            doc.languageId === 'typescript'
              ? tsModule.Extension.Ts
              : doc.languageId === 'tsx'
              ? tsModule.Extension.Tsx
              : tsModule.Extension.Js;
          return extension;
        }
      },
      getScriptSnapshot: (fileName: string) => {
        if (fileName.includes('node_modules')) {
          if (nodeModuleSnapshots.has(fileName)) {
            return nodeModuleSnapshots.get(fileName);
          }
          const fileText = tsModule.sys.readFile(fileName) || '';
          const snapshot: ts.IScriptSnapshot = {
            getText: (start, end) => fileText.substring(start, end),
            getLength: () => fileText.length,
            getChangeRange: () => void 0
          };
          nodeModuleSnapshots.set(fileName, snapshot);
          return snapshot;
        }

        if (fileName === bridge.fileName) {
          const text = isOldVersion ? bridge.oldContent : bridge.content;
          return {
            getText: (start, end) => text.substring(start, end),
            getLength: () => text.length,
            getChangeRange: () => void 0
          };
        }

        const fileFsPath = normalizeFileNameToFsPath(fileName);

        // .vue.template files are handled in pre-process phase
        if (isVirtualVueTemplateFile(fileFsPath)) {
          const doc = localScriptRegionDocuments.get(fileFsPath);
          const fileText = doc ? doc.getText() : '';
          return {
            getText: (start, end) => fileText.substring(start, end),
            getLength: () => fileText.length,
            getChangeRange: () => void 0
          };
        }

        // js/ts files in workspace
        if (!isVueFile(fileFsPath)) {
          if (projectFileSnapshots.has(fileFsPath)) {
            return projectFileSnapshots.get(fileFsPath);
          }
          const fileText = tsModule.sys.readFile(fileFsPath) || '';
          const snapshot: ts.IScriptSnapshot = {
            getText: (start, end) => fileText.substring(start, end),
            getLength: () => fileText.length,
            getChangeRange: () => void 0
          };
          projectFileSnapshots.set(fileFsPath, snapshot);
          return snapshot;
        }

        // vue files in workspace
        const doc = localScriptRegionDocuments.get(fileFsPath);
        if (doc) {
          const fileText = doc.getText();

          return {
            getText: (start, end) => fileText.substring(start, end),
            getLength: () => fileText.length,
            getChangeRange: () => void 0
          };
        } else {
          // .vue files that aren't loaded by VS Code yet
          if (notLoadedVueFileSnapshots.has(fileFsPath)) {
            return notLoadedVueFileSnapshots.get(fileFsPath);
          }

          const rawVueFileText = tsModule.sys.readFile(fileFsPath) || '';
          const fileText = parseVueScript(rawVueFileText);

          const snapshot: ts.IScriptSnapshot = {
            getText: (start, end) => fileText.substring(start, end),
            getLength: () => fileText.length,
            getChangeRange: () => void 0
          };

          notLoadedVueFileSnapshots.set(fileFsPath, snapshot);

          return snapshot;
        }
      },
      getCurrentDirectory: () => workspacePath,
      getDefaultLibFileName: tsModule.getDefaultLibFilePath,
      getNewLine: () => NEWLINE,
      useCaseSensitiveFileNames: () => true
    };
  }

  const jsHost = createLanguageServiceHost(compilerOptions);
  const templateHost = createLanguageServiceHost({
    ...compilerOptions,
    noImplicitAny: false,
    noUnusedLocals: false,
    noUnusedParameters: false,
    allowJs: true,
    checkJs: true
  });

  const registry = tsModule.createDocumentRegistry(true);
  let jsLanguageService = tsModule.createLanguageService(jsHost, registry);
  const templateLanguageService = tsModule.createLanguageService(templateHost, registry);

  return {
    queryVirtualFileInfo,
    updateCurrentVirtualVueTextDocument,
    updateCurrentVueTextDocument,
    updateExternalDocument,
    dispose: () => {
      jsLanguageService.dispose();
    }
  };
}

function defaultIgnorePatterns(tsModule: T_TypeScript, workspacePath: string) {
  const nodeModules = ['node_modules', '**/node_modules/*'];
  const gitignore = tsModule.findConfigFile(workspacePath, tsModule.sys.fileExists, '.gitignore');
  if (!gitignore) {
    return nodeModules;
  }
  const parsed: string[] = parseGitIgnore(gitignore);
  const filtered = parsed.filter(s => !s.startsWith('!'));
  return nodeModules.concat(filtered);
}

function getScriptKind(tsModule: T_TypeScript, langId: string): ts.ScriptKind {
  return langId === 'typescript'
    ? tsModule.ScriptKind.TS
    : langId === 'tsx'
    ? tsModule.ScriptKind.TSX
    : tsModule.ScriptKind.JS;
}

function inferIsUsingOldVueVersion(tsModule: T_TypeScript, workspacePath: string): boolean {
  const packageJSONPath = tsModule.findConfigFile(workspacePath, tsModule.sys.fileExists, 'package.json');
  try {
    const packageJSON = packageJSONPath && JSON.parse(tsModule.sys.readFile(packageJSONPath)!);
    const vueDependencyVersion = packageJSON.dependencies.vue || packageJSON.devDependencies.vue;

    if (vueDependencyVersion) {
      // use a sloppy method to infer version, to reduce dep on semver or so
      const vueDep = vueDependencyVersion.match(/\d+\.\d+/)[0];
      const sloppyVersion = parseFloat(vueDep);
      return sloppyVersion < 2.5;
    }

    const nodeModulesVuePackagePath = tsModule.findConfigFile(
      path.resolve(workspacePath, 'node_modules/vue'),
      tsModule.sys.fileExists,
      'package.json'
    );
    const nodeModulesVuePackageJSON =
      nodeModulesVuePackagePath && JSON.parse(tsModule.sys.readFile(nodeModulesVuePackagePath)!);
    const nodeModulesVueVersion = parseFloat(nodeModulesVuePackageJSON.version.match(/\d+\.\d+/)[0]);
    return nodeModulesVueVersion < 2.5;
  } catch (e) {
    return true;
  }
}

function getParsedConfig(tsModule: T_TypeScript, workspacePath: string) {
  const configFilename =
    tsModule.findConfigFile(workspacePath, tsModule.sys.fileExists, 'tsconfig.json') ||
    tsModule.findConfigFile(workspacePath, tsModule.sys.fileExists, 'jsconfig.json');
  const configJson = (configFilename && tsModule.readConfigFile(configFilename, tsModule.sys.readFile).config) || {
    exclude: defaultIgnorePatterns(tsModule, workspacePath)
  };
  // existingOptions should be empty since it always takes priority
  return tsModule.parseJsonConfigFileContent(
    configJson,
    tsModule.sys,
    workspacePath,
    /*existingOptions*/ {},
    configFilename,
    /*resolutionStack*/ undefined,
    [{ extension: 'vue', isMixedContent: true }]
  );
}
