'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { SceneHandler } = require('./scene-handler');
const { ComponentHandler } = require('./component-handler');

const ACTIONS = ['baseline', 'ensure_lab', 'ensure_scene', 'capture_material', 'validate_suite', 'capture', 'suite', 'setup', 'smoke_test'];
const DEFAULT_MANIFEST = 'db://assets/mcp_shader_debug/MCP_ShaderDebugLab.manifest.json';
const DEFAULT_CONTROLLER_NODE = 'MCP_ShaderDebugLabRoot';
const DEFAULT_CONTROLLER_COMPONENT = 'MCPShaderDebugLab';
const DEFAULT_CAPTURE_METHOD = 'captureMaterialAndReadPixels';
const DEFAULT_LAB_URL = 'db://assets/mcp_shader_debug';
const TEMPLATE_LAB_PATH = path.resolve(__dirname, '../../../../static/shader-debug-template/mcp_shader_debug');

function ok(data, message) {
    return { success: true, data, message };
}

function fail(error, data) {
    return { success: false, error, data };
}

function projectRoot() {
    try {
        if (globalThis.Editor && Editor.Project && Editor.Project.path) {
            return Editor.Project.path;
        }
    }
    catch (_) {}
    return process.cwd();
}

function normalizeSlash(value) {
    return String(value || '').replace(/\\/g, '/');
}

function dbUrlToFilePath(dbUrl) {
    const normalized = normalizeSlash(dbUrl);
    if (normalized === 'db://assets') {
        return path.join(projectRoot(), 'assets');
    }
    if (!normalized.startsWith('db://assets/')) {
        return null;
    }
    return path.join(projectRoot(), 'assets', normalized.slice('db://assets/'.length));
}

function filePathToDbUrl(filePath) {
    const root = path.join(projectRoot(), 'assets');
    const relative = path.relative(root, filePath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return `db://assets/${normalizeSlash(relative)}`;
    }
    return '';
}

function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadManifest(manifestUrl) {
    const url = manifestUrl || DEFAULT_MANIFEST;
    const filePath = dbUrlToFilePath(url);
    if (!filePath || !fs.existsSync(filePath)) {
        return { url, filePath, manifest: null };
    }
    return { url, filePath, manifest: readJsonFile(filePath) };
}

function sanitizeFilePart(value) {
    return String(value || 'material')
        .replace(/^db:\/\/assets\//, '')
        .replace(/\.[^.]+$/, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(-80) || 'material';
}

function resolveOutputPath(args, materialUrl) {
    const explicit = args.outputPath || args.output || '';
    if (explicit) {
        const asDbPath = explicit.startsWith('db://') ? dbUrlToFilePath(explicit) : null;
        const filePath = asDbPath || path.resolve(projectRoot(), explicit);
        return filePath.toLowerCase().endsWith('.png') ? filePath : `${filePath}.png`;
    }

    const capturesDir = path.join(projectRoot(), 'assets', 'mcp_shader_debug', 'captures');
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return path.join(capturesDir, `shader_debug_${stamp}_${sanitizeFilePart(materialUrl)}.png`);
}

function extensionRelative(filePath) {
    return normalizeSlash(path.relative(path.resolve(__dirname, '../../../..'), filePath));
}

function listFilesRecursive(root) {
    const files = [];
    if (!fs.existsSync(root)) {
        return files;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...listFilesRecursive(fullPath));
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }
    return files;
}

function shouldSkipTemplateFile(relativePath) {
    const normalized = normalizeSlash(relativePath);
    return normalized === 'captures.meta' || normalized.startsWith('captures/');
}

function resolveLabUrl(args = {}) {
    return args.labUrl || args.targetUrl || DEFAULT_LAB_URL;
}

function resolveManifestUrl(args = {}) {
    const labUrl = resolveLabUrl(args).replace(/\/+$/, '');
    return args.manifestUrl || `${labUrl}/MCP_ShaderDebugLab.manifest.json`;
}

function resolveLabSceneUrl(args = {}, manifest = {}) {
    const labUrl = resolveLabUrl(args).replace(/\/+$/, '');
    return args.sceneUrl || manifest.scene || `${labUrl}/MCP_ShaderDebugLab.scene`;
}

function resolveCapturesDir(args = {}) {
    const labUrl = resolveLabUrl(args).replace(/\/+$/, '');
    const explicit = args.outputDir || args.capturesDir || '';
    if (explicit) {
        if (explicit.startsWith('db://')) {
            const filePath = dbUrlToFilePath(explicit);
            return filePath || path.join(projectRoot(), 'assets', 'mcp_shader_debug', 'captures');
        }
        return path.resolve(projectRoot(), explicit);
    }
    return dbUrlToFilePath(`${labUrl}/captures`) || path.join(projectRoot(), 'assets', 'mcp_shader_debug', 'captures');
}

async function refreshAssetDb(url) {
    try {
        if (globalThis.Editor && Editor.Message && typeof Editor.Message.request === 'function') {
            await Editor.Message.request('asset-db', 'refresh-asset', url);
            return true;
        }
    } catch (_) {}
    return false;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function readMetaUuid(assetUrl) {
    const filePath = dbUrlToFilePath(assetUrl);
    const metaPath = filePath ? `${filePath}.meta` : '';
    if (!metaPath || !fs.existsSync(metaPath)) {
        return '';
    }
    try {
        const meta = readJsonFile(metaPath);
        return meta.uuid || '';
    } catch (_) {
        return '';
    }
}

function makeDiagnostic(category, severity, message, details = {}) {
    return {
        category,
        severity,
        message,
        details
    };
}

function normalizeDiagnosticText(value) {
    if (value == null) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch (_) {
        return String(value);
    }
}

function getMaterialAssetStatus(materialUrl) {
    if (!materialUrl || !String(materialUrl).startsWith('db://')) {
        return {
            ref: materialUrl || '',
            filePath: '',
            exists: null
        };
    }
    const filePath = dbUrlToFilePath(materialUrl);
    return {
        ref: materialUrl,
        filePath: filePath || '',
        exists: !!(filePath && fs.existsSync(filePath))
    };
}

function readJsonFileSafe(filePath) {
    try {
        return { ok: true, value: readJsonFile(filePath) };
    } catch (error) {
        return {
            ok: false,
            error: error && error.message ? error.message : String(error)
        };
    }
}

function scanMetaIndex(rootPath, options = {}) {
    const maxFiles = Number.isFinite(Number(options.maxFiles)) ? Number(options.maxFiles) : 6000;
    const skipDirNames = new Set(['captures', 'library', 'temp', 'build']);
    const byUuid = new Map();
    let scanned = 0;
    let truncated = false;

    const visit = (dirPath) => {
        if (!fs.existsSync(dirPath) || scanned >= maxFiles) {
            truncated = scanned >= maxFiles;
            return;
        }

        let entries = [];
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch (_) {
            return;
        }

        for (const entry of entries) {
            if (scanned >= maxFiles) {
                truncated = true;
                break;
            }
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                if (!skipDirNames.has(entry.name)) {
                    visit(fullPath);
                }
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.meta')) {
                continue;
            }

            scanned += 1;
            const meta = readJsonFileSafe(fullPath);
            if (!meta.ok || !meta.value) {
                continue;
            }
            const assetPath = fullPath.slice(0, -'.meta'.length);
            const asset = {
                uuid: meta.value.uuid || '',
                importer: meta.value.importer || meta.value.type || '',
                assetPath,
                assetUrl: filePathToDbUrl(assetPath),
                metaPath: fullPath
            };
            if (asset.uuid) {
                byUuid.set(asset.uuid, asset);
            }
            const subMetas = meta.value.subMetas || {};
            for (const [name, subMeta] of Object.entries(subMetas)) {
                if (subMeta && subMeta.uuid) {
                    byUuid.set(subMeta.uuid, {
                        ...asset,
                        uuid: subMeta.uuid,
                        subAssetName: name,
                        importer: subMeta.importer || asset.importer
                    });
                }
            }
        }
    };

    visit(rootPath);
    return {
        byUuid,
        scanned,
        truncated
    };
}

function getKnownBuiltinEffect(uuid) {
    const map = {
        'c8f66d17-351a-48da-a12c-0212d28575c4': 'builtin-standard',
        'a3cd009f-0ab0-420d-9278-b9fdab939bbc': 'builtin-unlit'
    };
    return map[uuid] || '';
}

function summarizeMaterialValue(value) {
    if (value == null) {
        return { type: 'null' };
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
        return { type: typeof value, value };
    }
    if (Array.isArray(value)) {
        return { type: 'array', length: value.length };
    }
    if (typeof value === 'object') {
        if (value.__uuid__) {
            return {
                type: 'assetRef',
                uuid: value.__uuid__,
                expectedType: value.__expectedType__ || ''
            };
        }
        if (value.__type__ === 'cc.Color') {
            return {
                type: 'color',
                value: {
                    r: value.r,
                    g: value.g,
                    b: value.b,
                    a: value.a
                }
            };
        }
        const keys = Object.keys(value);
        return {
            type: value.__type__ || 'object',
            keys: keys.slice(0, 12),
            keyCount: keys.length
        };
    }
    return { type: typeof value };
}

function collectAssetRefs(value, refs = [], pathParts = []) {
    if (!value || typeof value !== 'object') {
        return refs;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectAssetRefs(item, refs, pathParts.concat(String(index))));
        return refs;
    }
    if (value.__uuid__) {
        refs.push({
            path: pathParts.join('.'),
            uuid: value.__uuid__,
            expectedType: value.__expectedType__ || ''
        });
    }
    for (const [key, child] of Object.entries(value)) {
        if (key === '__uuid__' || key === '__expectedType__') {
            continue;
        }
        collectAssetRefs(child, refs, pathParts.concat(key));
    }
    return refs;
}

function inspectEffectAsset(effectUuid, metaIndex) {
    if (!effectUuid) {
        return {
            uuid: '',
            name: '',
            builtin: false,
            resolved: false,
            asset: null,
            source: null
        };
    }

    const knownBuiltin = getKnownBuiltinEffect(effectUuid);
    const asset = metaIndex && metaIndex.byUuid ? metaIndex.byUuid.get(effectUuid) : null;
    const result = {
        uuid: effectUuid,
        name: knownBuiltin,
        builtin: !!knownBuiltin,
        resolved: !!asset || !!knownBuiltin,
        asset: asset || null,
        source: null
    };

    if (asset && asset.assetPath && fs.existsSync(asset.assetPath)) {
        try {
            const source = fs.readFileSync(asset.assetPath, 'utf8');
            const passMatches = source.match(/passes\s*:/g) || [];
            const propertyMatches = source.match(/^\s{4,}[a-zA-Z_][\w-]*\s*:/gm) || [];
            result.source = {
                path: asset.assetPath,
                url: asset.assetUrl,
                fileSize: Buffer.byteLength(source),
                lineCount: source.split(/\r?\n/).length,
                passSectionCount: passMatches.length,
                propertyLikeLineCount: propertyMatches.length,
                shaders: [...new Set((source.match(/\b(?:vert|frag)\s*:\s*[\w-]+/g) || []).map((item) => item.replace(/\s+/g, ' ')))]
            };
        } catch (error) {
            result.source = {
                path: asset.assetPath,
                url: asset.assetUrl,
                error: error && error.message ? error.message : String(error)
            };
        }
    }

    return result;
}

function inspectMaterialAsset(materialUrl, options = {}) {
    const status = getMaterialAssetStatus(materialUrl);
    const metaIndex = scanMetaIndex(path.join(projectRoot(), 'assets'), {
        maxFiles: options.maxMetaFiles
    });
    const inspection = {
        status,
        readable: false,
        jsonValid: false,
        name: '',
        type: '',
        effect: null,
        techniqueIndex: null,
        techniqueSlots: {
            props: 0,
            defines: 0,
            states: 0
        },
        activePass: {
            props: {},
            defines: {},
            state: {}
        },
        propertySummary: {},
        assetRefs: [],
        metaIndex: {
            scanned: metaIndex.scanned,
            truncated: metaIndex.truncated
        },
        errors: []
    };

    if (!status.filePath || !fs.existsSync(status.filePath)) {
        return inspection;
    }

    const parsed = readJsonFileSafe(status.filePath);
    inspection.readable = parsed.ok;
    if (!parsed.ok) {
        inspection.errors.push(parsed.error);
        return inspection;
    }

    const material = parsed.value || {};
    inspection.jsonValid = true;
    inspection.name = material._name || '';
    inspection.type = material.__type__ || '';
    inspection.techniqueIndex = Number.isFinite(Number(material._techIdx)) ? Number(material._techIdx) : 0;
    inspection.techniqueSlots = {
        props: Array.isArray(material._props) ? material._props.length : 0,
        defines: Array.isArray(material._defines) ? material._defines.length : 0,
        states: Array.isArray(material._states) ? material._states.length : 0
    };

    const effectUuid = material._effectAsset && material._effectAsset.__uuid__ ? material._effectAsset.__uuid__ : '';
    inspection.effect = inspectEffectAsset(effectUuid, metaIndex);

    const activeIndex = Math.max(0, inspection.techniqueIndex || 0);
    const activeProps = Array.isArray(material._props) ? material._props[activeIndex] || {} : {};
    const activeDefines = Array.isArray(material._defines) ? material._defines[activeIndex] || {} : {};
    const activeState = Array.isArray(material._states) ? material._states[activeIndex] || {} : {};
    inspection.activePass = {
        index: activeIndex,
        props: activeProps,
        defines: activeDefines,
        state: activeState
    };

    for (const [key, value] of Object.entries(activeProps || {})) {
        inspection.propertySummary[key] = summarizeMaterialValue(value);
    }

    const refs = collectAssetRefs({
        effectAsset: material._effectAsset,
        props: material._props,
        defines: material._defines,
        states: material._states
    });
    inspection.assetRefs = refs.map((ref) => {
        const asset = ref.uuid ? metaIndex.byUuid.get(ref.uuid) : null;
        const builtinEffect = ref.path === 'effectAsset' ? getKnownBuiltinEffect(ref.uuid) : '';
        return {
            ...ref,
            resolved: !!asset || !!builtinEffect,
            builtin: builtinEffect || '',
            asset: asset || null
        };
    });

    return inspection;
}

function createImagePreview(outputPath, pngBuffer, args = {}) {
    const includeImageData = args.includeImageData !== false;
    const maxImageBytes = Number.isFinite(Number(args.maxImageBytes)) ? Number(args.maxImageBytes) : 1024 * 1024;
    const url = outputPath ? filePathToDbUrl(outputPath) : '';
    const preview = {
        available: !!outputPath,
        path: outputPath || '',
        url,
        mimeType: 'image/png',
        bytes: pngBuffer ? pngBuffer.length : 0,
        included: false,
        base64: '',
        dataUrl: '',
        markdown: outputPath ? `![shader-debug](${outputPath})` : '',
        omittedReason: ''
    };

    if (!includeImageData) {
        preview.omittedReason = 'includeImageData=false';
        return preview;
    }
    if (!pngBuffer) {
        preview.omittedReason = 'png buffer is empty';
        return preview;
    }
    if (pngBuffer.length > maxImageBytes) {
        preview.omittedReason = `image is larger than maxImageBytes (${pngBuffer.length} > ${maxImageBytes})`;
        return preview;
    }

    preview.included = true;
    preview.base64 = pngBuffer.toString('base64');
    preview.dataUrl = `data:image/png;base64,${preview.base64}`;
    return preview;
}

function classifyMaterialInspectionDiagnostics(inspection) {
    const diagnostics = [];
    if (!inspection || !inspection.status) {
        return diagnostics;
    }
    if (inspection.status.exists === false) {
        return diagnostics;
    }
    if (!inspection.readable) {
        diagnostics.push(makeDiagnostic('material_read_failed', 'error', 'Material file could not be read or parsed.', {
            errors: inspection.errors || [],
            filePath: inspection.status.filePath
        }));
        return diagnostics;
    }
    if (inspection.type && inspection.type !== 'cc.Material') {
        diagnostics.push(makeDiagnostic('material_type_unexpected', 'warning', 'Asset is not serialized as cc.Material.', {
            type: inspection.type
        }));
    }
    if (!inspection.effect || !inspection.effect.uuid) {
        diagnostics.push(makeDiagnostic('effect_missing', 'error', 'Material has no _effectAsset uuid.', {
            material: inspection.status.ref
        }));
    } else if (!inspection.effect.resolved) {
        diagnostics.push(makeDiagnostic('effect_unresolved', 'warning', 'Effect uuid was not found in project assets or known builtin effects.', {
            uuid: inspection.effect.uuid,
            material: inspection.status.ref
        }));
    }

    const slots = inspection.techniqueSlots || {};
    const index = inspection.techniqueIndex || 0;
    const slotCounts = [slots.props || 0, slots.defines || 0, slots.states || 0].filter((count) => count > 0);
    if (slotCounts.length && slotCounts.some((count) => index < 0 || index >= count)) {
        diagnostics.push(makeDiagnostic('technique_invalid', 'error', 'Material technique index is outside serialized slot ranges.', {
            techniqueIndex: index,
            techniqueSlots: slots
        }));
    }

    const missingRefs = (inspection.assetRefs || [])
        .filter((ref) => ref.path !== 'effectAsset' && ref.uuid && !ref.resolved);
    if (missingRefs.length) {
        diagnostics.push(makeDiagnostic('material_binding_missing', 'error', 'Material contains unresolved asset references in properties/states.', {
            missingRefs
        }));
    }

    return diagnostics;
}

function dedupeDiagnostics(diagnostics) {
    const seen = new Set();
    const result = [];
    for (const diagnostic of diagnostics) {
        if (!diagnostic || !diagnostic.category) {
            continue;
        }
        const key = `${diagnostic.category}:${diagnostic.message}`;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(diagnostic);
        }
    }
    return result;
}

function classifyDiagnostics(context = {}) {
    const diagnostics = [];
    const stage = context.stage || 'unknown';
    const materialStatus = context.materialStatus || getMaterialAssetStatus(context.materialUrl || '');
    const error = context.error || '';
    const data = context.data || {};
    const debug = context.debug || {};
    const capture = context.capture || debug.capture || {};
    const visualCheck = context.visualCheck || debug.visualCheck || null;
    const materialInspection = context.materialInspection || debug.materialInspection || null;
    const targets = Array.isArray(context.targets) ? context.targets : Array.isArray(debug.targets) ? debug.targets : [];
    diagnostics.push(...classifyMaterialInspectionDiagnostics(materialInspection));
    const rawText = [
        error,
        data.error,
        data.message,
        debug.error,
        debug.message,
        capture.error,
        capture.message,
        ...(Array.isArray(debug.errors) ? debug.errors : []),
        ...(Array.isArray(data.errors) ? data.errors : [])
    ].map(normalizeDiagnosticText).join('\n').toLowerCase();

    if (materialStatus.exists === false) {
        diagnostics.push(makeDiagnostic(
            'material_missing',
            'error',
            'Material asset file does not exist.',
            materialStatus
        ));
    }

    if (/material.*(not found|missing|invalid|\u4e0d\u5b58\u5728|\u4e22\u5931)|failed to .*material/.test(rawText)) {
        diagnostics.push(makeDiagnostic('material_missing', 'error', 'Material lookup or load failed.', { stage }));
    }

    if (targets.length && targets.some((target) => !target.effectName)) {
        diagnostics.push(makeDiagnostic(
            'effect_missing',
            'error',
            'One or more target renderers have no resolved effect name.',
            { targets: targets.filter((target) => !target.effectName).map((target) => target.node || target.name || '') }
        ));
    }

    if (/effect.*(not found|missing|invalid|\u4e0d\u5b58\u5728|\u4e22\u5931)|technique.*(not found|missing)/.test(rawText)) {
        diagnostics.push(makeDiagnostic('effect_missing', 'error', 'Effect or technique lookup failed.', { stage }));
    }

    if (/(shader|program|glsl|wgsl|compile|compilation).*(error|failed|fail)|syntax error/.test(rawText)) {
        diagnostics.push(makeDiagnostic('shader_compile_failed', 'error', 'Shader compilation appears to have failed.', { stage }));
    }

    if (/(uniform|property|sampler|texture|define).*(missing|not found|invalid|undefined|\u4e0d\u5b58\u5728|\u4e22\u5931)/.test(rawText)) {
        diagnostics.push(makeDiagnostic('material_binding_missing', 'error', 'Material property, uniform, texture, sampler, or define appears to be missing.', { stage }));
    }

    const cameraFailurePattern = /(?:camera|rendertexture|render texture|readpixels|read pixels).*(?:error|failed|fail|invalid|missing|not found|unsupported|exception)|(?:error|failed|fail|invalid|missing|not found|unsupported|exception).*(?:camera|rendertexture|render texture|readpixels|read pixels)/;
    if (capture.supported === false || cameraFailurePattern.test(rawText)) {
        diagnostics.push(makeDiagnostic('camera_error', 'error', 'Camera/render texture/readPixels path reported an issue.', {
            stage,
            captureSupported: capture.supported
        }));
    }

    if (capture.camera) {
        const before = capture.camera.beforeReadPixels || capture.camera.afterTargetTexture || capture.camera.beforeTargetTexture || {};
        if (before.activeInHierarchy === false || before.enabled === false) {
            diagnostics.push(makeDiagnostic('camera_error', 'error', 'ShaderDebugCamera is disabled or inactive.', {
                activeInHierarchy: before.activeInHierarchy,
                enabled: before.enabled
            }));
        }
        if (before.rect && (before.rect.width <= 0 || before.rect.height <= 0)) {
            diagnostics.push(makeDiagnostic('camera_error', 'error', 'ShaderDebugCamera rect has no visible area.', { rect: before.rect }));
        }
    }

    if (visualCheck && visualCheck.metrics) {
        const metrics = visualCheck.metrics;
        if (metrics.foregroundRatio < 0.01) {
            diagnostics.push(makeDiagnostic('blank_capture', 'error', 'Capture appears blank or almost identical to the clear color.', metrics));
        } else if (visualCheck.pass === false) {
            diagnostics.push(makeDiagnostic('target_not_visible', 'error', 'Capture has pixels, but expected targets are not reliably visible.', {
                reasons: visualCheck.reasons || [],
                metrics
            }));
        }
    }

    if (stage === 'controller' || /mcpshaderdebuglab component|controller/.test(rawText)) {
        diagnostics.push(makeDiagnostic('controller_missing', 'error', 'MCPShaderDebugLab controller component could not be resolved.', { stage }));
    }

    if (!diagnostics.length && (error || data.error || debug.error || (debug.success === false))) {
        diagnostics.push(makeDiagnostic('unknown', 'error', 'Shader debug failed, but no known failure category matched.', { stage }));
    }

    return dedupeDiagnostics(diagnostics);
}

function buildCaptureReport(context = {}) {
    const debug = context.debug || {};
    const capture = context.capture || debug.capture || {};
    const outputPath = context.outputPath || '';
    const debugPath = context.debugPath || '';
    const width = Number(context.width || capture.width || 0);
    const height = Number(context.height || capture.height || 0);
    const visualCheck = context.visualCheck || debug.visualCheck || null;
    const preview = context.preview || debug.preview || null;
    const materialInspection = context.materialInspection || debug.materialInspection || null;
    const targets = Array.isArray(debug.targets) ? debug.targets : [];
    const diagnostics = context.diagnostics || classifyDiagnostics({
        ...context,
        debug,
        capture,
        visualCheck,
        materialInspection,
        targets
    });
    const materialRef = context.materialUrl || debug.materialRef || '';
    const materialUuid = debug.materialUuid || readMetaUuid(materialRef) || '';
    const materialName = debug.materialName || (materialInspection && materialInspection.name) || '';
    return {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        tool: 'cocos_shader_debug',
        action: 'capture_material',
        status: context.success && diagnostics.every((item) => item.severity !== 'error') ? 'pass' : 'fail',
        material: {
            ref: materialRef,
            uuid: materialUuid,
            name: materialName,
            asset: context.materialStatus || getMaterialAssetStatus(materialRef)
        },
        image: {
            path: outputPath,
            url: outputPath ? filePathToDbUrl(outputPath) : '',
            width,
            height,
            fileSize: context.fileSize || 0,
            format: outputPath ? 'png' : ''
        },
        preview,
        debugFile: {
            path: debugPath,
            url: debugPath ? filePathToDbUrl(debugPath) : ''
        },
        materialInspection,
        visualCheck,
        diagnostics,
        camera: capture.camera || null,
        targets,
        scene: context.sceneEnsure || null,
        timings: {
            elapsedMs: debug.elapsedMs || null
        },
        errors: debug.errors || []
    };
}

function getResponseMode(args = {}, defaultMode = 'summary') {
    const mode = String(args.responseMode || args.detail || defaultMode).toLowerCase();
    return mode === 'full' || mode === 'raw' ? 'full' : 'summary';
}

function compactDiagnostics(diagnostics) {
    return (Array.isArray(diagnostics) ? diagnostics : []).map((diagnostic) => ({
        category: diagnostic.category || '',
        severity: diagnostic.severity || '',
        message: diagnostic.message || ''
    }));
}

function compactMaterialInspection(inspection) {
    if (!inspection) {
        return null;
    }
    const effect = inspection.effect || {};
    return {
        name: inspection.name || '',
        type: inspection.type || '',
        effect: {
            uuid: effect.uuid || '',
            name: effect.name || '',
            builtin: !!effect.builtin,
            resolved: !!effect.resolved,
            url: effect.asset ? effect.asset.assetUrl || '' : ''
        },
        techniqueIndex: inspection.techniqueIndex,
        techniqueSlots: inspection.techniqueSlots || null,
        propertySummary: inspection.propertySummary || {},
        unresolvedRefs: (inspection.assetRefs || [])
            .filter((ref) => ref.uuid && !ref.resolved)
            .map((ref) => ({
                path: ref.path,
                uuid: ref.uuid,
                expectedType: ref.expectedType || ''
            })),
        errors: inspection.errors || []
    };
}

function compactVisualCheck(visualCheck) {
    if (!visualCheck) {
        return null;
    }
    const metrics = visualCheck.metrics || {};
    return {
        status: visualCheck.status || (visualCheck.pass ? 'pass' : 'fail'),
        pass: !!visualCheck.pass,
        reasons: visualCheck.reasons || [],
        metrics: {
            width: metrics.width,
            height: metrics.height,
            foregroundRatio: metrics.foregroundRatio,
            foregroundBounds: metrics.foregroundBounds || null,
            edgeTouchRatio: metrics.edgeTouchRatio,
            colorBucketCount: metrics.colorBucketCount,
            luminanceMean: metrics.luminanceMean,
            luminanceStdDev: metrics.luminanceStdDev,
            componentCount: metrics.componentCount
        }
    };
}

function summarizeCaptureData(data = {}) {
    const report = data.report || {};
    const preview = data.preview || report.preview || null;
    return {
        schemaVersion: data.schemaVersion || report.schemaVersion || 2,
        status: data.status || report.status || '',
        material: data.material || report.material || null,
        image: data.image || report.image || null,
        preview: preview ? {
            available: !!preview.available,
            path: preview.path || '',
            url: preview.url || '',
            mimeType: preview.mimeType || 'image/png',
            bytes: preview.bytes || 0,
            included: !!preview.included,
            dataUrl: preview.dataUrl || '',
            markdown: preview.markdown || '',
            omittedReason: preview.omittedReason || ''
        } : null,
        debugFile: data.debugFile || report.debugFile || null,
        materialInspection: compactMaterialInspection(data.materialInspection || report.materialInspection),
        visualCheck: compactVisualCheck(data.visualCheck || report.visualCheck),
        diagnostics: compactDiagnostics(data.diagnostics || report.diagnostics),
        targets: (data.targets || report.targets || []).map((target) => ({
            node: target.node || target.name || '',
            renderer: target.renderer || '',
            slot: target.slot,
            enabled: target.enabled,
            materialName: target.materialName || '',
            materialUuid: target.materialUuid || '',
            effectName: target.effectName || ''
        })),
        sceneEnsure: data.sceneEnsure ? {
            sceneUrl: data.sceneEnsure.sceneUrl || '',
            alreadyOpen: !!data.sceneEnsure.alreadyOpen,
            opened: !!data.sceneEnsure.opened
        } : null,
        componentUuid: data.componentUuid || ''
    };
}

function summarizeSuiteResult(result = {}) {
    const inspection = result.materialInspection || (result.report && result.report.materialInspection) || null;
    return {
        name: result.name || '',
        category: result.category || '',
        materialUrl: result.materialUrl || '',
        success: !!result.success,
        status: result.status || '',
        imagePath: result.imagePath || '',
        imageUrl: result.imageUrl || '',
        debugPath: result.debugPath || '',
        debugUrl: result.debugUrl || '',
        diagnostics: compactDiagnostics(result.diagnostics || []),
        diagnosticCategories: result.diagnosticCategories || [],
        visualCheck: compactVisualCheck(result.visualCheck),
        materialInspection: compactMaterialInspection(inspection),
        effects: result.effects || []
    };
}

function summarizeSuiteData(summary = {}) {
    return {
        schemaVersion: summary.schemaVersion || 2,
        generatedAt: summary.generatedAt || '',
        tool: summary.tool || 'cocos_shader_debug',
        action: summary.action || 'validate_suite',
        status: summary.status || '',
        count: summary.count || 0,
        passCount: summary.passCount || 0,
        failCount: summary.failCount || 0,
        labUrl: summary.labUrl || '',
        manifestUrl: summary.manifestUrl || '',
        capturesDir: summary.capturesDir || '',
        summaryPath: summary.summaryPath || '',
        summaryUrl: summary.summaryUrl || '',
        report: summary.report || {
            summaryPath: summary.summaryPath || '',
            summaryUrl: summary.summaryUrl || '',
            contactSheet: summary.contactSheet || null,
            htmlReport: summary.htmlReport || null
        },
        ensure: summary.ensure ? {
            copiedCount: summary.ensure.copiedCount || 0,
            skippedCount: summary.ensure.skippedCount || 0,
            overwrittenCount: summary.ensure.overwrittenCount || 0,
            manifestExists: !!summary.ensure.manifestExists
        } : null,
        sceneEnsure: summary.sceneEnsure ? {
            sceneUrl: summary.sceneEnsure.sceneUrl || '',
            alreadyOpen: !!summary.sceneEnsure.alreadyOpen,
            opened: !!summary.sceneEnsure.opened
        } : null,
        results: (summary.results || []).map(summarizeSuiteResult)
    };
}

let crcTable = null;

function getCrcTable() {
    if (crcTable) {
        return crcTable;
    }
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crcTable[n] = c >>> 0;
    }
    return crcTable;
}

function crc32(buffer) {
    const table = getCrcTable();
    let c = 0xffffffff;
    for (let index = 0; index < buffer.length; index += 1) {
        c = table[(c ^ buffer[index]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(data.length, 0);
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function rgbaToPngBuffer(rgba, width, height, flipY) {
    const stride = width * 4;
    const expected = stride * height;
    if (!Buffer.isBuffer(rgba)) {
        rgba = Buffer.from(rgba);
    }
    if (rgba.length < expected) {
        throw new Error(`RGBA buffer too small: ${rgba.length}, expected ${expected}.`);
    }

    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const target = y * (stride + 1);
        const sourceY = flipY ? height - 1 - y : y;
        raw[target] = 0;
        rgba.copy(raw, target + 1, sourceY * stride, sourceY * stride + stride);
    }

    const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    return Buffer.concat([
        header,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

function pngBufferToRgba(buffer) {
    if (!Buffer.isBuffer(buffer)) {
        buffer = Buffer.from(buffer);
    }
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) {
        throw new Error('Invalid PNG signature.');
    }

    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idatChunks = [];

    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > buffer.length) {
            throw new Error(`Invalid PNG chunk length for ${type}.`);
        }
        const data = buffer.subarray(dataStart, dataEnd);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
        } else if (type === 'IDAT') {
            idatChunks.push(data);
        } else if (type === 'IEND') {
            break;
        }
        offset = dataEnd + 4;
    }

    if (!width || !height || bitDepth !== 8 || colorType !== 6) {
        throw new Error(`Unsupported PNG format: ${width}x${height}, bitDepth=${bitDepth}, colorType=${colorType}.`);
    }

    const compressed = Buffer.concat(idatChunks);
    const raw = zlib.inflateSync(compressed);
    const bytesPerPixel = 4;
    const stride = width * bytesPerPixel;
    const rgba = Buffer.alloc(stride * height);
    const previous = Buffer.alloc(stride);
    const current = Buffer.alloc(stride);
    let rawOffset = 0;

    const paeth = (a, b, c) => {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        if (pa <= pb && pa <= pc) {
            return a;
        }
        return pb <= pc ? b : c;
    };

    for (let y = 0; y < height; y += 1) {
        const filter = raw[rawOffset++];
        raw.copy(current, 0, rawOffset, rawOffset + stride);
        rawOffset += stride;

        for (let x = 0; x < stride; x += 1) {
            const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
            const up = previous[x];
            const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
            if (filter === 1) {
                current[x] = (current[x] + left) & 0xff;
            } else if (filter === 2) {
                current[x] = (current[x] + up) & 0xff;
            } else if (filter === 3) {
                current[x] = (current[x] + Math.floor((left + up) / 2)) & 0xff;
            } else if (filter === 4) {
                current[x] = (current[x] + paeth(left, up, upLeft)) & 0xff;
            } else if (filter !== 0) {
                throw new Error(`Unsupported PNG filter: ${filter}.`);
            }
        }

        current.copy(rgba, y * stride, 0, stride);
        current.copy(previous, 0, 0, stride);
    }

    return { width, height, rgba };
}

function fillRgbaRect(buffer, width, x, y, rectWidth, rectHeight, color) {
    const r = color.r == null ? 0 : color.r;
    const g = color.g == null ? 0 : color.g;
    const b = color.b == null ? 0 : color.b;
    const a = color.a == null ? 255 : color.a;
    for (let yy = Math.max(0, y); yy < y + rectHeight; yy += 1) {
        for (let xx = Math.max(0, x); xx < x + rectWidth; xx += 1) {
            if (xx < 0 || yy < 0 || xx >= width || yy * width * 4 >= buffer.length) {
                continue;
            }
            const index = (yy * width + xx) * 4;
            buffer[index] = r;
            buffer[index + 1] = g;
            buffer[index + 2] = b;
            buffer[index + 3] = a;
        }
    }
}

function fillStripedRgbaRect(buffer, width, x, y, rectWidth, rectHeight, colorA, colorB, stripeSize = 16) {
    for (let yy = Math.max(0, y); yy < y + rectHeight; yy += 1) {
        for (let xx = Math.max(0, x); xx < x + rectWidth; xx += 1) {
            if (xx < 0 || yy < 0 || xx >= width || yy * width * 4 >= buffer.length) {
                continue;
            }
            const stripe = Math.floor((xx + yy) / stripeSize) % 2 === 0 ? colorA : colorB;
            const index = (yy * width + xx) * 4;
            buffer[index] = stripe.r == null ? 0 : stripe.r;
            buffer[index + 1] = stripe.g == null ? 0 : stripe.g;
            buffer[index + 2] = stripe.b == null ? 0 : stripe.b;
            buffer[index + 3] = stripe.a == null ? 255 : stripe.a;
        }
    }
}

function blitRgbaScaled(target, targetWidth, targetHeight, source, sourceWidth, sourceHeight, x, y, width, height) {
    for (let ty = 0; ty < height; ty += 1) {
        const yy = y + ty;
        if (yy < 0 || yy >= targetHeight) {
            continue;
        }
        const sy = Math.min(sourceHeight - 1, Math.floor(ty * sourceHeight / height));
        for (let tx = 0; tx < width; tx += 1) {
            const xx = x + tx;
            if (xx < 0 || xx >= targetWidth) {
                continue;
            }
            const sx = Math.min(sourceWidth - 1, Math.floor(tx * sourceWidth / width));
            const sourceIndex = (sy * sourceWidth + sx) * 4;
            const targetIndex = (yy * targetWidth + xx) * 4;
            target[targetIndex] = source[sourceIndex];
            target[targetIndex + 1] = source[sourceIndex + 1];
            target[targetIndex + 2] = source[sourceIndex + 2];
            target[targetIndex + 3] = source[sourceIndex + 3];
        }
    }
}

function htmlEscape(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toRelativeReportPath(fromFilePath, targetPath) {
    if (!targetPath) {
        return '';
    }
    return normalizeSlash(path.relative(path.dirname(fromFilePath), targetPath));
}

function buildSuiteContactSheet(results, outputPath, options = {}) {
    const columns = Math.max(1, Math.min(4, Number(options.columns || 2)));
    const thumbWidth = Math.max(160, Number(options.thumbWidth || 480));
    const thumbHeight = Math.max(90, Number(options.thumbHeight || 270));
    const padding = 24;
    const border = 8;
    const labelStrip = 24;
    const tileWidth = thumbWidth + border * 2;
    const tileHeight = thumbHeight + border * 2 + labelStrip;
    const rows = Math.max(1, Math.ceil(Math.max(1, results.length) / columns));
    const sheetWidth = padding * 2 + columns * tileWidth + (columns - 1) * padding;
    const sheetHeight = padding * 2 + rows * tileHeight + (rows - 1) * padding;
    const rgba = Buffer.alloc(sheetWidth * sheetHeight * 4);

    fillRgbaRect(rgba, sheetWidth, 0, 0, sheetWidth, sheetHeight, { r: 31, g: 31, b: 31, a: 255 });

    results.forEach((result, index) => {
        const col = index % columns;
        const row = Math.floor(index / columns);
        const x = padding + col * (tileWidth + padding);
        const y = padding + row * (tileHeight + padding);
        const passed = result.status === 'pass' && result.success;
        const stripeA = passed
            ? { r: 34, g: 197, b: 94, a: 255 }
            : { r: 239, g: 68, b: 68, a: 255 };
        const stripeB = passed
            ? { r: 15, g: 23, b: 42, a: 255 }
            : { r: 250, g: 204, b: 21, a: 255 };
        fillStripedRgbaRect(rgba, sheetWidth, x, y, tileWidth, tileHeight, stripeA, stripeB, 18);
        fillRgbaRect(rgba, sheetWidth, x + border, y + border, thumbWidth, thumbHeight, { r: 17, g: 24, b: 39, a: 255 });
        fillRgbaRect(rgba, sheetWidth, x + border, y + border + thumbHeight, thumbWidth, labelStrip, passed
            ? { r: 20, g: 83, b: 45, a: 255 }
            : { r: 127, g: 29, b: 29, a: 255 });

        if (result.imagePath && fs.existsSync(result.imagePath)) {
            try {
                const image = pngBufferToRgba(fs.readFileSync(result.imagePath));
                blitRgbaScaled(
                    rgba,
                    sheetWidth,
                    sheetHeight,
                    image.rgba,
                    image.width,
                    image.height,
                    x + border,
                    y + border,
                    thumbWidth,
                    thumbHeight
                );
            } catch (error) {
                result.contactSheetError = error && error.message ? error.message : String(error);
            }
        }
    });

    const png = rgbaToPngBuffer(rgba, sheetWidth, sheetHeight, false);
    fs.writeFileSync(outputPath, png);
    return {
        path: outputPath,
        url: filePathToDbUrl(outputPath),
        width: sheetWidth,
        height: sheetHeight,
        fileSize: png.length,
        columns,
        rows
    };
}

function buildSuiteHtmlReport(summary, outputPath) {
    const contactSheet = summary.contactSheet || null;
    const resultCards = (summary.results || []).map((result) => {
        const diagnostics = (result.diagnostics || [])
            .map((diagnostic) => `<li><strong>${htmlEscape(diagnostic.category)}</strong> [${htmlEscape(diagnostic.severity)}] ${htmlEscape(diagnostic.message)}</li>`)
            .join('') || '<li>None</li>';
        const inspection = result.materialInspection || {};
        const effect = inspection.effect || {};
        const imageSrc = toRelativeReportPath(outputPath, result.imagePath);
        const debugHref = toRelativeReportPath(outputPath, result.debugPath);
        const status = result.status || (result.success ? 'pass' : 'fail');
        return `
            <section class="card ${htmlEscape(status)}">
                <div class="card-header">
                    <div>
                        <h2>${htmlEscape(result.name || result.materialName || result.materialUrl)}</h2>
                        <p>${htmlEscape(result.materialUrl)}</p>
                    </div>
                    <span class="badge">${htmlEscape(status)}</span>
                </div>
                ${imageSrc ? `<img class="capture" src="${htmlEscape(imageSrc)}" alt="${htmlEscape(result.name)}">` : '<div class="missing-image">No image</div>'}
                <dl>
                    <dt>Effect</dt><dd>${htmlEscape(effect.name || '')} ${effect.uuid ? `(${htmlEscape(effect.uuid)})` : ''}</dd>
                    <dt>Technique</dt><dd>${htmlEscape(inspection.techniqueIndex == null ? '' : inspection.techniqueIndex)}</dd>
                    <dt>Visual</dt><dd>${htmlEscape(result.visualCheck ? result.visualCheck.status : '')}</dd>
                    <dt>Debug</dt><dd>${debugHref ? `<a href="${htmlEscape(debugHref)}">${htmlEscape(debugHref)}</a>` : ''}</dd>
                </dl>
                <h3>Diagnostics</h3>
                <ul>${diagnostics}</ul>
            </section>
        `;
    }).join('\n');

    const html = `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Shader Debug Suite Report</title>
    <style>
        :root { color-scheme: dark; font-family: Arial, sans-serif; background: #1f2933; color: #e5e7eb; }
        body { margin: 0; padding: 24px; }
        header { margin-bottom: 24px; }
        h1 { margin: 0 0 8px; font-size: 24px; }
        .summary { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 12px; }
        .pill { padding: 6px 10px; background: #111827; border: 1px solid #374151; }
        .contact { display: block; max-width: 100%; margin: 18px 0 26px; border: 1px solid #374151; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
        .card { background: #111827; border: 1px solid #374151; padding: 14px; }
        .card.pass { border-color: #22c55e; }
        .card.fail { border-color: #ef4444; }
        .card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
        .card h2 { margin: 0; font-size: 16px; }
        .card p { margin: 4px 0 0; color: #9ca3af; font-size: 12px; word-break: break-all; }
        .badge { padding: 4px 8px; background: #1f2937; border: 1px solid #4b5563; text-transform: uppercase; font-size: 12px; }
        .capture { width: 100%; aspect-ratio: 16 / 9; object-fit: contain; background: #020617; margin: 12px 0; }
        dl { display: grid; grid-template-columns: 86px 1fr; gap: 6px 10px; margin: 12px 0; font-size: 13px; }
        dt { color: #9ca3af; }
        dd { margin: 0; word-break: break-all; }
        h3 { font-size: 13px; margin: 12px 0 6px; color: #cbd5e1; }
        ul { margin: 0; padding-left: 18px; font-size: 13px; }
        a { color: #93c5fd; }
    </style>
</head>
<body>
    <header>
        <h1>Shader Debug Suite Report</h1>
        <div>${htmlEscape(summary.generatedAt)}</div>
        <div class="summary">
            <span class="pill">Status: ${htmlEscape(summary.status)}</span>
            <span class="pill">Pass: ${htmlEscape(summary.passCount)}</span>
            <span class="pill">Fail: ${htmlEscape(summary.failCount)}</span>
            <span class="pill">Total: ${htmlEscape(summary.count)}</span>
        </div>
    </header>
    ${contactSheet && contactSheet.path ? `<img class="contact" src="${htmlEscape(toRelativeReportPath(outputPath, contactSheet.path))}" alt="contact sheet">` : ''}
    <main class="grid">
        ${resultCards}
    </main>
</body>
</html>`;
    fs.writeFileSync(outputPath, html, 'utf8');
    return {
        path: outputPath,
        url: filePathToDbUrl(outputPath),
        fileSize: Buffer.byteLength(html)
    };
}

function averageCornerColor(rgba, width, height) {
    const patch = Math.max(8, Math.min(32, Math.floor(Math.min(width, height) * 0.035)));
    const corners = [
        [0, 0],
        [width - patch, 0],
        [0, height - patch],
        [width - patch, height - patch]
    ];
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    let count = 0;

    for (const [startX, startY] of corners) {
        for (let y = 0; y < patch; y += 1) {
            for (let x = 0; x < patch; x += 1) {
                const index = ((startY + y) * width + startX + x) * 4;
                r += rgba[index];
                g += rgba[index + 1];
                b += rgba[index + 2];
                a += rgba[index + 3];
                count += 1;
            }
        }
    }

    return {
        r: Math.round(r / count),
        g: Math.round(g / count),
        b: Math.round(b / count),
        a: Math.round(a / count)
    };
}

function analyzeCaptureVisual(rgba, width, height) {
    const totalPixels = width * height;
    const background = averageCornerColor(rgba, width, height);
    const colorThreshold = 18;
    const thresholdSq = colorThreshold * colorThreshold;
    const edgeMarginX = Math.max(2, Math.floor(width * 0.02));
    const edgeMarginY = Math.max(2, Math.floor(height * 0.02));
    const gridWidth = 160;
    const gridHeight = 90;
    const grid = new Uint8Array(gridWidth * gridHeight);
    const gridCounts = new Uint16Array(gridWidth * gridHeight);
    const gridCellPixels = Math.max(1, Math.floor(width / gridWidth) * Math.floor(height / gridHeight));
    let foregroundPixels = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let edgePixels = 0;
    let luminanceSum = 0;
    let luminanceSqSum = 0;
    const colorBuckets = new Set();

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = (y * width + x) * 4;
            const dr = rgba[index] - background.r;
            const dg = rgba[index + 1] - background.g;
            const db = rgba[index + 2] - background.b;
            const da = rgba[index + 3] - background.a;
            if (rgba[index + 3] > 8 && dr * dr + dg * dg + db * db + da * da * 0.25 > thresholdSq) {
                foregroundPixels += 1;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
                if (x < edgeMarginX || x >= width - edgeMarginX || y < edgeMarginY || y >= height - edgeMarginY) {
                    edgePixels += 1;
                }

                const luminance = rgba[index] * 0.2126 + rgba[index + 1] * 0.7152 + rgba[index + 2] * 0.0722;
                luminanceSum += luminance;
                luminanceSqSum += luminance * luminance;
                colorBuckets.add(`${rgba[index] >> 4},${rgba[index + 1] >> 4},${rgba[index + 2] >> 4}`);

                const gx = Math.min(gridWidth - 1, Math.floor(x * gridWidth / width));
                const gy = Math.min(gridHeight - 1, Math.floor(y * gridHeight / height));
                gridCounts[gy * gridWidth + gx] += 1;
            }
        }
    }

    for (let i = 0; i < gridCounts.length; i += 1) {
        if (gridCounts[i] >= Math.max(2, Math.floor(gridCellPixels * 0.15))) {
            grid[i] = 1;
        }
    }

    const visited = new Uint8Array(grid.length);
    const components = [];
    const queue = [];
    for (let i = 0; i < grid.length; i += 1) {
        if (!grid[i] || visited[i]) {
            continue;
        }
        let head = 0;
        let cells = 0;
        let cMinX = gridWidth;
        let cMinY = gridHeight;
        let cMaxX = -1;
        let cMaxY = -1;
        visited[i] = 1;
        queue.length = 0;
        queue.push(i);

        while (head < queue.length) {
            const current = queue[head++];
            const x = current % gridWidth;
            const y = Math.floor(current / gridWidth);
            cells += 1;
            cMinX = Math.min(cMinX, x);
            cMinY = Math.min(cMinY, y);
            cMaxX = Math.max(cMaxX, x);
            cMaxY = Math.max(cMaxY, y);
            const neighbors = [
                x > 0 ? current - 1 : -1,
                x < gridWidth - 1 ? current + 1 : -1,
                y > 0 ? current - gridWidth : -1,
                y < gridHeight - 1 ? current + gridWidth : -1
            ];
            for (const next of neighbors) {
                if (next >= 0 && grid[next] && !visited[next]) {
                    visited[next] = 1;
                    queue.push(next);
                }
            }
        }

        components.push({
            cells,
            bounds: { x: cMinX, y: cMinY, width: cMaxX - cMinX + 1, height: cMaxY - cMinY + 1 }
        });
    }
    components.sort((a, b) => b.cells - a.cells);

    const foregroundRatio = foregroundPixels / totalPixels;
    const edgeTouchRatio = foregroundPixels ? edgePixels / foregroundPixels : 0;
    const bounds = foregroundPixels ? {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
    } : null;
    const bboxAreaRatio = bounds ? (bounds.width * bounds.height) / totalPixels : 0;
    const luminanceMean = foregroundPixels ? luminanceSum / foregroundPixels : 0;
    const luminanceVariance = foregroundPixels ? Math.max(0, luminanceSqSum / foregroundPixels - luminanceMean * luminanceMean) : 0;
    const reasons = [];

    if (foregroundRatio < 0.01) {
        reasons.push(`foreground ratio too low (${foregroundRatio.toFixed(4)})`);
    }
    if (foregroundRatio > 0.55) {
        reasons.push(`foreground ratio too high (${foregroundRatio.toFixed(4)})`);
    }
    if (bboxAreaRatio > 0.65) {
        reasons.push(`foreground bounds cover too much image (${bboxAreaRatio.toFixed(4)})`);
    }
    if (edgeTouchRatio > 0.08) {
        reasons.push(`foreground touches capture edge (${edgeTouchRatio.toFixed(4)})`);
    }
    if (!components.length) {
        reasons.push('no foreground components detected');
    }
    if (bounds && (bounds.width < width * 0.12 || bounds.height < height * 0.12)) {
        reasons.push('foreground bounds are too small for shader debug lab');
    }

    return {
        pass: reasons.length === 0,
        status: reasons.length === 0 ? 'pass' : 'fail',
        reasons,
        metrics: {
            width,
            height,
            background,
            foregroundPixels,
            foregroundRatio,
            foregroundBounds: bounds,
            foregroundBoundsAreaRatio: bboxAreaRatio,
            edgePixels,
            edgeTouchRatio,
            colorBucketCount: colorBuckets.size,
            luminanceMean,
            luminanceStdDev: Math.sqrt(luminanceVariance),
            componentCount: components.length,
            largestComponents: components.slice(0, 5)
        }
    };
}

class ShaderDebugHandler {
    constructor() {
        this.scene = new SceneHandler();
        this.component = new ComponentHandler();
    }

    getToolDefinition() {
        return {
            name: 'shader_debug',
            description: [
                'Built-in shader/material debug lab for fast visual validation.',
                'Recommended flow: call setup once, then capture for one material or suite/smoke_test for batch validation.',
                'The tool auto-ensures db://assets/mcp_shader_debug from the bundled MCP template, opens MCP_ShaderDebugLab.scene, applies materials to fixed Targets, captures ShaderDebugCamera, and writes PNG/debug/report files under assets/mcp_shader_debug/captures.',
                'For suite/smoke_test prefer responseMode:"summary" and includeSuiteImageData:false; inspect report.contactSheet.path and report.htmlReport.path.',
                'On failures inspect diagnostics, visualCheck, materialInspection, camera, targets, imagePath, and debugPath. Do not use browser-preview JS injection for this lab unless explicitly testing runtime behavior.'
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ACTIONS,
                        description: 'setup creates/checks the lab; capture/capture_material validates one material; suite/validate_suite validates a material list; smoke_test runs the manifest default materials; baseline/ensure_lab/ensure_scene are lower-level checks.'
                    },
                    labUrl: { type: 'string', description: 'Shader debug lab folder db:// URL. Default db://assets/mcp_shader_debug. The folder is kept in the project and is not auto-deleted.' },
                    targetUrl: { type: 'string', description: 'Alias of labUrl for ensure_lab.' },
                    overwrite: { type: 'boolean', description: 'ensure_lab only: overwrite existing lab files. Default false; avoid true unless deliberately refreshing the template.' },
                    dryRun: { type: 'boolean', description: 'ensure_lab/restart helper style checks: preview the operation without writing or restarting.' },
                    refresh: { type: 'boolean', description: 'ensure_lab: refresh asset-db after copy. Default true.' },
                    sceneUrl: { type: 'string', description: 'Shader debug lab scene db:// URL. Default from manifest.scene.' },
                    materialUrl: { type: 'string', description: 'capture/capture_material: material db:// URL or UUID to apply to all nodes under Targets.' },
                    material: { type: 'string', description: 'Alias of materialUrl.' },
                    materials: {
                        type: 'array',
                        description: 'suite/validate_suite: material URLs or objects such as {name, url/materialUrl, category}. Defaults to manifest.validationMaterials.',
                        items: {
                            oneOf: [
                                { type: 'string' },
                                {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string' },
                                        url: { type: 'string' },
                                        materialUrl: { type: 'string' },
                                        category: { type: 'string' }
                                    }
                                }
                            ]
                        }
                    },
                    manifestUrl: { type: 'string', description: 'Template manifest db:// URL.' },
                    controllerNode: { type: 'string', description: 'Root/controller node. Default MCP_ShaderDebugLabRoot.' },
                    componentUuid: { type: 'string', description: 'Optional MCPShaderDebugLab component UUID.' },
                    componentName: { type: 'string', description: 'Controller component class name. Default MCPShaderDebugLab.' },
                    methodName: { type: 'string', description: 'Capture method name. Default captureMaterialAndReadPixels.' },
                    width: { type: 'number', description: 'Capture width. Default from scene script.' },
                    height: { type: 'number', description: 'Capture height. Default from scene script.' },
                    includeImageData: { type: 'boolean', description: 'capture/capture_material: include PNG base64/dataUrl in preview for direct model inspection. Default true.' },
                    includeSuiteImageData: { type: 'boolean', description: 'suite/validate_suite: include PNG base64/dataUrl for each material capture. Default false; keep false for normal batch reports.' },
                    maxImageBytes: { type: 'number', description: 'Maximum PNG bytes to inline in preview. Default 1048576.' },
                    maxMetaFiles: { type: 'number', description: 'Maximum .meta files scanned for material/effect reference diagnostics. Default 6000.' },
                    reportHtml: { type: 'boolean', description: 'suite/validate_suite/smoke_test: generate an HTML report. Default true.' },
                    contactSheet: { type: 'boolean', description: 'suite/validate_suite/smoke_test: generate a PNG contact sheet with striped pass/fail borders. Default true.' },
                    contactSheetColumns: { type: 'number', description: 'suite/validate_suite/smoke_test: contact sheet columns. Default 2.' },
                    contactSheetThumbWidth: { type: 'number', description: 'suite/validate_suite/smoke_test: contact sheet thumbnail width. Default 480.' },
                    contactSheetThumbHeight: { type: 'number', description: 'suite/validate_suite/smoke_test: contact sheet thumbnail height. Default 270.' },
                    responseMode: { type: 'string', enum: ['summary', 'full'], description: 'summary returns compact output with file links and essential diagnostics; full includes the full debug payload. Default summary for suite/setup/smoke_test and summary-compatible for capture.' },
                    outputPath: { type: 'string', description: 'capture/capture_material: PNG output path or db://assets path.' },
                    outputDir: { type: 'string', description: 'suite/validate_suite/smoke_test: output directory for PNG/debug/summary/contact-sheet/report files.' },
                    ensureLab: { type: 'boolean', description: 'Run ensure_lab before scene/capture. Default true for ensure_scene/capture/validate_suite.' },
                    ensureScene: { type: 'boolean', description: 'Open the shader debug lab scene before capture. Default true.' },
                    allowDirtySceneSwitch: { type: 'boolean', description: 'Allow opening the lab scene when current scene has unsaved changes. Default false; prefer saveCurrentScene:true when automation may switch scenes.' },
                    saveCurrentScene: { type: 'boolean', description: 'Save the current dirty scene before opening the lab scene. Default false.' }
                },
                required: ['action']
            }
        };
    }

    async execute(args = {}) {
        switch (args.action) {
            case 'baseline':
                return await this.baseline(args);
            case 'ensure_lab':
                return await this.ensureLab(args);
            case 'ensure_scene':
                return await this.ensureLabScene(args);
            case 'capture':
            case 'capture_material':
                return await this.captureMaterial(args);
            case 'suite':
            case 'validate_suite':
                return await this.validateSuite(args);
            case 'setup':
                return await this.setup(args);
            case 'smoke_test':
                return await this.smokeTest(args);
            default:
                return fail(`Unknown shader_debug action: ${args.action || ''}`);
        }
    }

    async ensureLab(args = {}) {
        const labUrl = resolveLabUrl(args).replace(/\/+$/, '');
        const targetPath = dbUrlToFilePath(labUrl);
        const overwrite = !!args.overwrite;
        const dryRun = !!args.dryRun;
        const refresh = args.refresh !== false;

        if (!targetPath) {
            return fail(`Invalid labUrl: ${labUrl}`);
        }
        if (!fs.existsSync(TEMPLATE_LAB_PATH)) {
            return fail('Shader debug template is missing from the MCP extension.', {
                templatePath: TEMPLATE_LAB_PATH
            });
        }

        const templateFiles = listFilesRecursive(TEMPLATE_LAB_PATH)
            .map((sourcePath) => ({
                sourcePath,
                relativePath: normalizeSlash(path.relative(TEMPLATE_LAB_PATH, sourcePath))
            }))
            .filter((item) => !shouldSkipTemplateFile(item.relativePath));
        const copied = [];
        const skipped = [];
        const overwritten = [];

        for (const item of templateFiles) {
            const targetFile = path.join(targetPath, item.relativePath);
            const exists = fs.existsSync(targetFile);
            if (exists && !overwrite) {
                skipped.push(item.relativePath);
                continue;
            }

            if (!dryRun) {
                fs.mkdirSync(path.dirname(targetFile), { recursive: true });
                fs.copyFileSync(item.sourcePath, targetFile);
            }
            if (exists) {
                overwritten.push(item.relativePath);
            } else {
                copied.push(item.relativePath);
            }
        }

        const capturesDir = path.join(targetPath, 'captures');
        if (!dryRun) {
            fs.mkdirSync(capturesDir, { recursive: true });
        }
        const refreshed = !dryRun && refresh ? await refreshAssetDb(labUrl) : false;
        const manifestUrl = `${labUrl}/MCP_ShaderDebugLab.manifest.json`;
        const manifestPath = dbUrlToFilePath(manifestUrl);
        const manifestExists = !!(manifestPath && fs.existsSync(manifestPath));

        return ok({
            labUrl,
            targetPath,
            templatePath: TEMPLATE_LAB_PATH,
            templatePathRelative: extensionRelative(TEMPLATE_LAB_PATH),
            dryRun,
            overwrite,
            copiedCount: copied.length,
            skippedCount: skipped.length,
            overwrittenCount: overwritten.length,
            copied,
            skipped,
            overwritten,
            capturesDir,
            manifestUrl,
            manifestExists,
            refreshed
        }, dryRun ? 'Shader debug lab ensure preview completed.' : 'Shader debug lab is available.');
    }

    async getCurrentSceneInfo() {
        const info = await this.scene.execute({ action: 'get_info' });
        return info && info.success ? info.data || {} : {};
    }

    async getSceneDirtyInfo() {
        const dirty = await this.scene.execute({ action: 'is_dirty' });
        return dirty && dirty.success ? dirty.data || {} : {};
    }

    async ensureLabScene(args = {}) {
        let ensureResult = null;
        if (args.ensureLab !== false) {
            ensureResult = await this.ensureLab({
                ...args,
                action: 'ensure_lab',
                overwrite: !!args.overwrite,
                dryRun: false
            });
            if (!ensureResult || !ensureResult.success) {
                return fail('Failed to ensure shader debug lab.', ensureResult);
            }
        }

        const manifestUrl = resolveManifestUrl(args);
        const manifestInfo = loadManifest(manifestUrl);
        const manifest = manifestInfo.manifest || {};
        if (!manifestInfo.manifest) {
            return fail('Shader debug manifest not found after ensure_lab.', {
                manifestUrl,
                manifestPath: manifestInfo.filePath,
                ensureResult
            });
        }

        const sceneUrl = resolveLabSceneUrl(args, manifest);
        const scenePath = dbUrlToFilePath(sceneUrl);
        if (!scenePath || !fs.existsSync(scenePath)) {
            return fail('Shader debug lab scene not found.', {
                sceneUrl,
                scenePath,
                manifestUrl,
                manifestPath: manifestInfo.filePath,
                ensureResult
            });
        }

        const sceneUuid = readMetaUuid(sceneUrl);
        const currentBefore = await this.getCurrentSceneInfo();
        const alreadyOpen = !!(
            (sceneUuid && currentBefore.uuid === sceneUuid)
            || currentBefore.name === path.basename(scenePath, '.scene')
        );

        if (alreadyOpen || args.ensureScene === false) {
            return ok({
                labUrl: resolveLabUrl(args),
                manifestUrl,
                manifestPath: manifestInfo.filePath,
                sceneUrl,
                scenePath,
                sceneUuid,
                alreadyOpen,
                opened: false,
                currentBefore,
                currentAfter: currentBefore,
                ensure: ensureResult ? ensureResult.data || ensureResult : null
            }, alreadyOpen ? 'Shader debug lab scene is already open.' : 'Shader debug lab scene ensure skipped by args.');
        }

        const dirtyInfo = await this.getSceneDirtyInfo();
        if (dirtyInfo.isDirty && !args.saveCurrentScene && args.allowDirtySceneSwitch !== true) {
            return fail('Current scene has unsaved changes; refusing to open shader debug lab scene automatically.', {
                sceneUrl,
                currentBefore,
                dirtyInfo,
                instruction: 'Pass saveCurrentScene:true to save first, or allowDirtySceneSwitch:true to force opening the lab scene.'
            });
        }

        let saveResult = null;
        if (dirtyInfo.isDirty && args.saveCurrentScene) {
            saveResult = await this.scene.execute({ action: 'save' });
            if (!saveResult || !saveResult.success) {
                return fail('Failed to save current dirty scene before opening shader debug lab scene.', {
                    sceneUrl,
                    currentBefore,
                    dirtyInfo,
                    saveResult
                });
            }
        }

        const openResult = await this.scene.execute({ action: 'open', scenePath: sceneUrl });
        if (!openResult || !openResult.success) {
            return fail('Failed to open shader debug lab scene.', {
                sceneUrl,
                scenePath,
                currentBefore,
                dirtyInfo,
                saveResult,
                openResult
            });
        }

        let currentAfter = {};
        for (let attempt = 0; attempt < 10; attempt += 1) {
            await sleep(100);
            currentAfter = await this.getCurrentSceneInfo();
            if ((sceneUuid && currentAfter.uuid === sceneUuid) || currentAfter.name === path.basename(scenePath, '.scene')) {
                break;
            }
        }

        const opened = !!((sceneUuid && currentAfter.uuid === sceneUuid) || currentAfter.name === path.basename(scenePath, '.scene'));
        if (!opened) {
            return fail('Shader debug lab scene open command returned success, but current scene did not switch to the lab scene.', {
                sceneUrl,
                scenePath,
                sceneUuid,
                currentBefore,
                currentAfter,
                dirtyInfo,
                saveResult,
                openResult
            });
        }

        return ok({
            labUrl: resolveLabUrl(args),
            manifestUrl,
            manifestPath: manifestInfo.filePath,
            sceneUrl,
            scenePath,
            sceneUuid,
            alreadyOpen: false,
            opened: true,
            currentBefore,
            currentAfter,
            dirtyInfo,
            saveResult,
            openResult,
            ensure: ensureResult ? ensureResult.data || ensureResult : null
        }, 'Shader debug lab scene opened.');
    }

    async baseline(args = {}) {
        const manifestInfo = loadManifest(resolveManifestUrl(args));
        const manifest = manifestInfo.manifest || {};
        const controller = await this.resolveController(args, manifest);

        const rawModelAssets = manifest.modelAssets || [];
        const modelAssetEntries = Array.isArray(rawModelAssets)
            ? rawModelAssets.map((asset) => [asset.name || '', asset])
            : Object.entries(rawModelAssets);
        const modelAssets = modelAssetEntries.map(([key, asset]) => {
            const source = asset.source || asset.url || '';
            const filePath = dbUrlToFilePath(source);
            return {
                name: asset.name || key || '',
                source,
                meshUuid: asset.meshUuid || asset.mesh || '',
                exists: !!(filePath && fs.existsSync(filePath))
            };
        });

        return ok({
            projectRoot: projectRoot(),
            manifestUrl: manifestInfo.url,
            manifestExists: !!manifestInfo.manifest,
            scene: manifest.scene || '',
            controller,
            modelAssets,
            validationMaterials: manifest.validationMaterials || [],
            capture: manifest.capture || null
        }, 'Shader debug baseline checked.');
    }

    normalizeSuiteMaterials(args = {}, manifest = {}) {
        const source = Array.isArray(args.materials) && args.materials.length
            ? args.materials
            : Array.isArray(manifest.validationMaterials) ? manifest.validationMaterials : [];
        return source
            .map((entry, index) => {
                if (typeof entry === 'string') {
                    return {
                        name: sanitizeFilePart(entry) || `material_${index + 1}`,
                        url: entry,
                        category: ''
                    };
                }
                if (entry && typeof entry === 'object') {
                    const url = entry.url || entry.materialUrl || entry.material || '';
                    return {
                        name: entry.name || sanitizeFilePart(url) || `material_${index + 1}`,
                        url,
                        category: entry.category || ''
                    };
                }
                return null;
            })
            .filter((entry) => entry && entry.url);
    }

    async setup(args = {}) {
        const ensureResult = await this.ensureLab({
            ...args,
            action: 'ensure_lab',
            overwrite: !!args.overwrite,
            dryRun: !!args.dryRun
        });
        if (!ensureResult || !ensureResult.success) {
            return ensureResult;
        }

        const baselineResult = args.dryRun ? null : await this.baseline({
            ...args,
            action: 'baseline'
        });
        const data = {
            schemaVersion: 1,
            action: 'setup',
            status: baselineResult && baselineResult.success === false ? 'fail' : 'pass',
            labUrl: resolveLabUrl(args),
            ensure: ensureResult.data || ensureResult,
            baseline: baselineResult ? baselineResult.data || baselineResult : null
        };
        if (getResponseMode(args) === 'full') {
            return ok(data, 'Shader debug lab setup completed.');
        }
        return ok({
            schemaVersion: data.schemaVersion,
            action: data.action,
            status: data.status,
            labUrl: data.labUrl,
            ensure: data.ensure ? {
                copiedCount: data.ensure.copiedCount || 0,
                skippedCount: data.ensure.skippedCount || 0,
                overwrittenCount: data.ensure.overwrittenCount || 0,
                manifestExists: !!data.ensure.manifestExists,
                targetPath: data.ensure.targetPath || '',
                capturesDir: data.ensure.capturesDir || ''
            } : null,
            baseline: data.baseline ? {
                manifestExists: !!data.baseline.manifestExists,
                scene: data.baseline.scene || '',
                controller: data.baseline.controller ? {
                    node: data.baseline.controller.node || '',
                    componentName: data.baseline.controller.componentName || '',
                    componentUuid: data.baseline.controller.componentUuid || '',
                    source: data.baseline.controller.source || ''
                } : null,
                validationMaterialCount: Array.isArray(data.baseline.validationMaterials)
                    ? data.baseline.validationMaterials.length
                    : 0,
                modelAssets: data.baseline.modelAssets || []
            } : null
        }, 'Shader debug lab setup completed.');
    }

    async smokeTest(args = {}) {
        const outputDir = args.outputDir || 'db://assets/mcp_shader_debug/captures/smoke_test';
        return await this.validateSuite({
            ...args,
            action: 'validate_suite',
            outputDir,
            includeSuiteImageData: args.includeSuiteImageData === true,
            contactSheet: args.contactSheet !== false,
            reportHtml: args.reportHtml !== false,
            responseMode: args.responseMode || 'summary'
        });
    }

    async validateSuite(args = {}) {
        let ensureResult = null;
        if (args.ensureLab !== false) {
            ensureResult = await this.ensureLab({
                ...args,
                action: 'ensure_lab',
                overwrite: !!args.overwrite,
                dryRun: false
            });
            if (!ensureResult || !ensureResult.success) {
                return fail('Failed to ensure shader debug lab before validation.', ensureResult);
            }
        }

        const manifestUrl = resolveManifestUrl(args);
        const manifestInfo = loadManifest(manifestUrl);
        const manifest = manifestInfo.manifest || {};
        if (!manifestInfo.manifest) {
            return fail('Shader debug manifest not found.', {
                manifestUrl,
                manifestPath: manifestInfo.filePath,
                ensureResult
            });
        }

        const materials = this.normalizeSuiteMaterials(args, manifest);
        if (!materials.length) {
            return fail('No validation materials found. Pass materials or define manifest.validationMaterials.', {
                manifestUrl,
                manifestPath: manifestInfo.filePath
            });
        }

        let sceneEnsureResult = null;
        if (args.ensureScene !== false) {
            sceneEnsureResult = await this.ensureLabScene({
                ...args,
                action: 'ensure_scene',
                ensureLab: false,
                manifestUrl
            });
            if (!sceneEnsureResult || !sceneEnsureResult.success) {
                return fail('Failed to ensure/open shader debug lab scene before validation.', sceneEnsureResult);
            }
        }

        const capturesDir = resolveCapturesDir(args);
        fs.mkdirSync(capturesDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const results = [];

        for (const material of materials) {
            const outputPath = path.join(capturesDir, `suite_${stamp}_${sanitizeFilePart(material.name)}.png`);
            const captureResult = await this.captureMaterial({
                ...args,
                action: 'capture_material',
                ensureLab: false,
                ensureScene: false,
                manifestUrl,
                materialUrl: material.url,
                outputPath,
                includeImageData: !!args.includeSuiteImageData,
                responseMode: 'full'
            });
            const data = captureResult && captureResult.data ? captureResult.data : {};
            const visualCheck = data.visualCheck || (data.debug && data.debug.visualCheck) || null;
            const report = data.report || (data.debug && data.debug.report) || null;
            const diagnostics = data.diagnostics || (report && report.diagnostics) || [];
            results.push({
                name: material.name,
                category: material.category || '',
                materialUrl: material.url,
                success: !!(captureResult && captureResult.success),
                status: report ? report.status : (captureResult && captureResult.success ? 'pass' : 'fail'),
                message: captureResult ? captureResult.message || captureResult.error || '' : 'No capture result.',
                imagePath: data.imagePath || '',
                imageUrl: data.imageUrl || '',
                preview: data.preview || null,
                debugPath: data.debugPath || '',
                debugUrl: data.debugUrl || '',
                report,
                diagnostics,
                materialInspection: data.materialInspection || (report && report.materialInspection) || null,
                diagnosticCategories: diagnostics.map((item) => item.category).filter(Boolean),
                visualCheck,
                materialName: data.debug ? data.debug.materialName || '' : '',
                materialUuid: data.debug ? data.debug.materialUuid || '' : '',
                effects: data.debug && Array.isArray(data.debug.targets)
                    ? [...new Set(data.debug.targets.map((target) => target.effectName).filter(Boolean))]
                    : []
            });
        }

        const passCount = results.filter((item) => item.success && item.visualCheck && item.visualCheck.pass).length;
        const failCount = results.length - passCount;
        const contactSheetPath = path.join(capturesDir, `suite_${stamp}_contact_sheet.png`);
        const htmlReportPath = path.join(capturesDir, `suite_${stamp}_report.html`);
        const summary = {
            schemaVersion: 2,
            generatedAt: new Date().toISOString(),
            tool: 'cocos_shader_debug',
            action: 'validate_suite',
            labUrl: resolveLabUrl(args),
            manifestUrl,
            manifestPath: manifestInfo.filePath,
            capturesDir,
            count: results.length,
            passCount,
            failCount,
            status: failCount === 0 ? 'pass' : 'fail',
            ensure: ensureResult ? ensureResult.data || ensureResult : null,
            sceneEnsure: sceneEnsureResult ? sceneEnsureResult.data || sceneEnsureResult : null,
            contactSheet: null,
            htmlReport: null,
            results
        };

        if (args.contactSheet !== false) {
            try {
                summary.contactSheet = buildSuiteContactSheet(results, contactSheetPath, {
                    columns: args.contactSheetColumns,
                    thumbWidth: args.contactSheetThumbWidth,
                    thumbHeight: args.contactSheetThumbHeight
                });
            } catch (error) {
                summary.contactSheet = {
                    path: contactSheetPath,
                    url: filePathToDbUrl(contactSheetPath),
                    error: error && error.message ? error.message : String(error)
                };
            }
        }

        if (args.reportHtml !== false) {
            try {
                summary.htmlReport = buildSuiteHtmlReport(summary, htmlReportPath);
            } catch (error) {
                summary.htmlReport = {
                    path: htmlReportPath,
                    url: filePathToDbUrl(htmlReportPath),
                    error: error && error.message ? error.message : String(error)
                };
            }
        }

        const summaryPath = path.join(capturesDir, `suite_${stamp}_summary.json`);
        fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
        const summaryUrl = filePathToDbUrl(summaryPath);
        await refreshAssetDb(filePathToDbUrl(capturesDir) || resolveLabUrl(args));

        const fullData = {
            ...summary,
            summaryPath,
            summaryUrl,
            report: {
                summaryPath,
                summaryUrl,
                contactSheet: summary.contactSheet,
                htmlReport: summary.htmlReport
            }
        };
        const responseData = getResponseMode(args) === 'full' ? fullData : summarizeSuiteData(fullData);
        return ok(responseData, `Shader debug material suite ${summary.status}: ${passCount}/${results.length} passed.`);
    }

    async captureMaterial(args = {}) {
        const materialUrl = args.materialUrl || args.material;
        if (!materialUrl) {
            const report = buildCaptureReport({
                success: false,
                materialUrl: '',
                stage: 'material',
                error: 'materialUrl is required for capture_material.',
                diagnostics: [makeDiagnostic('material_missing', 'error', 'materialUrl is required for capture_material.')]
            });
            return fail('materialUrl is required for capture_material.', {
                report,
                diagnostics: report.diagnostics
            });
        }

        let sceneEnsureResult = null;
        const materialInspection = inspectMaterialAsset(materialUrl, args);
        const materialStatus = materialInspection.status || getMaterialAssetStatus(materialUrl);
        const failWithReport = (message, stage, data = {}) => {
            const diagnostics = classifyDiagnostics({
                stage,
                error: message,
                data,
                materialUrl,
                materialStatus,
                materialInspection,
                sceneEnsure: sceneEnsureResult ? sceneEnsureResult.data || sceneEnsureResult : null
            });
            const report = buildCaptureReport({
                success: false,
                materialUrl,
                stage,
                error: message,
                data,
                diagnostics,
                materialStatus,
                materialInspection,
                sceneEnsure: sceneEnsureResult ? sceneEnsureResult.data || sceneEnsureResult : null
            });
            return fail(message, {
                ...data,
                report,
                diagnostics,
                material: report.material,
                materialInspection: report.materialInspection,
                image: report.image,
                preview: report.preview,
                debugFile: report.debugFile,
                visualCheck: report.visualCheck,
                camera: report.camera,
                targets: report.targets
            });
        };

        if (args.ensureScene !== false) {
            sceneEnsureResult = await this.ensureLabScene({
                ...args,
                action: 'ensure_scene'
            });
            if (!sceneEnsureResult || !sceneEnsureResult.success) {
                return failWithReport('Failed to ensure/open shader debug lab scene before capture.', 'scene', sceneEnsureResult);
            }
        } else if (args.ensureLab !== false) {
            const ensureResult = await this.ensureLab({
                ...args,
                action: 'ensure_lab',
                overwrite: !!args.overwrite,
                dryRun: false
            });
            if (!ensureResult || !ensureResult.success) {
                return failWithReport('Failed to ensure shader debug lab before capture.', 'ensure_lab', ensureResult);
            }
        }

        if (materialStatus.exists === false) {
            return failWithReport('Material asset file does not exist.', 'material', { materialStatus });
        }

        const manifestInfo = loadManifest(resolveManifestUrl(args));
        let controller = null;
        try {
            controller = await this.resolveController(args, manifestInfo.manifest || {});
        } catch (error) {
            return failWithReport('Unable to resolve MCPShaderDebugLab component.', 'controller', {
                error: error && error.message ? error.message : String(error)
            });
        }
        if (!controller.componentUuid) {
            return failWithReport('Unable to find MCPShaderDebugLab component.', 'controller', controller);
        }

        const methodName = args.methodName || DEFAULT_CAPTURE_METHOD;
        const methodArgs = [materialUrl];
        if (args.width !== undefined) {
            methodArgs.push(String(args.width));
        }
        if (args.height !== undefined) {
            methodArgs.push(String(args.height));
        }

        let execution = null;
        try {
            execution = await this.scene.execute({
                action: 'execute_method',
                uuid: controller.componentUuid,
                name: methodName,
                args: methodArgs
            });
        } catch (error) {
            return failWithReport('Failed to execute shader debug capture method.', 'execute', {
                error: error && error.message ? error.message : String(error)
            });
        }

        if (!execution || !execution.success) {
            return failWithReport('Failed to execute shader debug capture method.', 'execute', execution);
        }

        const debug = execution.data || {};
        const capture = debug.capture || {};
        if (!debug.success || !capture.supported || !capture.pixelsBase64) {
            return failWithReport('Shader debug capture did not return pixel data.', 'capture', debug);
        }

        const width = Number(capture.width || args.width || 512);
        const height = Number(capture.height || args.height || 512);
        const rgba = Buffer.from(capture.pixelsBase64, 'base64');
        const outputPath = resolveOutputPath(args, materialUrl);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const pngBuffer = rgbaToPngBuffer(rgba, width, height, capture.origin === 'bottom-left');
        const visualCheck = analyzeCaptureVisual(rgba, width, height);
        fs.writeFileSync(outputPath, pngBuffer);
        const preview = createImagePreview(outputPath, pngBuffer, args);

        const strippedDebug = JSON.parse(JSON.stringify(debug));
        if (strippedDebug.capture) {
            delete strippedDebug.capture.pixelsBase64;
            strippedDebug.capture.imagePath = outputPath;
            strippedDebug.capture.imageUrl = filePathToDbUrl(outputPath);
            strippedDebug.capture.fileSize = pngBuffer.length;
            strippedDebug.capture.format = 'png';
        }
        strippedDebug.visualCheck = visualCheck;
        strippedDebug.preview = preview;
        strippedDebug.materialInspection = materialInspection;
        const diagnostics = classifyDiagnostics({
            stage: 'capture',
            materialUrl,
            materialStatus,
            materialInspection,
            debug: strippedDebug,
            capture: strippedDebug.capture || {},
            visualCheck,
            targets: strippedDebug.targets || []
        });
        const report = buildCaptureReport({
            success: true,
            materialUrl,
            materialStatus,
            outputPath,
            debugPath: outputPath.replace(/\.png$/i, '.debug.json'),
            fileSize: pngBuffer.length,
            width,
            height,
            preview,
            materialInspection,
            debug: strippedDebug,
            capture: strippedDebug.capture || {},
            visualCheck,
            diagnostics,
            sceneEnsure: sceneEnsureResult ? sceneEnsureResult.data || sceneEnsureResult : null
        });
        strippedDebug.diagnostics = diagnostics;
        strippedDebug.report = report;
        const debugPath = outputPath.replace(/\.png$/i, '.debug.json');
        fs.writeFileSync(debugPath, JSON.stringify(strippedDebug, null, 2), 'utf8');

        const fullData = {
            schemaVersion: report.schemaVersion,
            status: report.status,
            imagePath: outputPath,
            imageUrl: filePathToDbUrl(outputPath),
            preview,
            debugPath,
            debugUrl: filePathToDbUrl(debugPath),
            material: report.material,
            materialInspection: report.materialInspection,
            image: report.image,
            debugFile: report.debugFile,
            visualCheck,
            diagnostics,
            report,
            camera: report.camera,
            targets: report.targets,
            errors: report.errors,
            sceneEnsure: sceneEnsureResult ? sceneEnsureResult.data || sceneEnsureResult : null,
            componentUuid: controller.componentUuid,
            debug: strippedDebug
        };
        const responseData = getResponseMode(args, 'summary') === 'full' ? fullData : summarizeCaptureData(fullData);
        return ok(responseData, `ShaderDebugCamera capture saved: ${outputPath}; debug saved: ${debugPath}; visualCheck=${visualCheck.status}`);
    }

    async resolveController(args = {}, manifest = {}) {
        const controller = manifest.controller || {};
        const componentName = args.componentName || controller.component || DEFAULT_CONTROLLER_COMPONENT;
        const node = args.controllerNode || controller.node || DEFAULT_CONTROLLER_NODE;

        if (args.componentUuid) {
            return { node, componentName, componentUuid: args.componentUuid, source: 'args' };
        }

        const listed = await this.component.execute({ action: 'list', node });
        const components = listed && listed.success && listed.data ? listed.data.components || [] : [];
        const matched = components.find((item) => {
            const nameValue = item && item.properties && item.properties.name && item.properties.name.value;
            const scriptAsset = item && item.properties && item.properties.__scriptAsset && item.properties.__scriptAsset.value;
            return (nameValue && String(nameValue).includes(`<${componentName}>`))
                || (item && item.type === componentName)
                || (scriptAsset && controller.scriptUuid && scriptAsset.uuid === controller.scriptUuid);
        });

        return {
            node,
            componentName,
            componentUuid: matched ? matched.uuid : '',
            nodeUuid: listed && listed.data ? listed.data.nodeUuid : '',
            source: matched ? 'component.list' : 'not-found',
            components: components.map((item) => ({
                type: item.type,
                uuid: item.uuid,
                name: item.properties && item.properties.name ? item.properties.name.value : ''
            }))
        };
    }
}

exports.ShaderDebugHandler = ShaderDebugHandler;
