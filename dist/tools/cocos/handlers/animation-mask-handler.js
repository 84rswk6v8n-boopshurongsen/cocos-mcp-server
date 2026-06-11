'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class AnimationMaskHandler {
    getToolDefinition() {
        return {
            name: 'animation_mask',
            description: [
                'Animation Mask asset editing — create/query/update .animask resources for Marionette animation layers.',
                'Actions: create, query, set_joint, batch_set_joints, remove_joint, clear, list, inspect_skeleton, validate_paths, skeleton_path_normalize, source_adapters.',
                'Example: {action:"batch_set_joints", url:"db://assets/masks/UpperBody.animask", joints:[{path:"Root/Spine", enabled:true}]}'
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['create', 'query', 'set_joint', 'batch_set_joints', 'remove_joint', 'clear', 'list', 'inspect_skeleton', 'validate_paths', 'skeleton_path_normalize', 'source_adapters'],
                        description: 'Animation mask action to perform'
                    },
                    url: {
                        type: 'string',
                        description: 'Mask asset URL, e.g. db://assets/anim/masks/UpperBody.animask'
                    },
                    folder: {
                        type: 'string',
                        description: 'Folder URL for list action, default db://assets'
                    },
                    name: {
                        type: 'string',
                        description: 'Optional mask asset _name'
                    },
                    path: {
                        type: 'string',
                        description: 'Joint path inside the skeleton hierarchy'
                    },
                    enabled: {
                        type: 'boolean',
                        description: 'Whether the joint path is enabled in the mask'
                    },
                    joints: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                path: { type: 'string' },
                                enabled: { type: 'boolean' }
                            },
                            required: ['path', 'enabled']
                        },
                        description: 'Joint mask entries: [{path, enabled}]'
                    },
                    overwrite: {
                        type: 'boolean',
                        description: 'Create action: overwrite existing file, default false'
                    },
                    createIfMissing: {
                        type: 'boolean',
                        description: 'Update action: create the mask file when missing, default true'
                    },
                    sourceType: {
                        type: 'string',
                        enum: ['node', 'prefab', 'model'],
                        description: 'Skeleton source type for inspect_skeleton/validate_paths'
                    },
                    node: {
                        type: 'string',
                        description: 'Scene node path or UUID for sourceType=node'
                    },
                    sourceUrl: {
                        type: 'string',
                        description: 'Prefab/model asset URL for skeleton inspection'
                    },
                    modelUrl: {
                        type: 'string',
                        description: 'Model asset URL for sourceType=model'
                    },
                    prefabUrl: {
                        type: 'string',
                        description: 'Prefab asset URL for sourceType=prefab'
                    },
                    paths: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Joint paths for validate_paths/skeleton_path_normalize'
                    },
                    rootName: {
                        type: 'string',
                        description: 'Skeleton root name used to strip scene-node prefixes, e.g. Bip001'
                    },
                    includeRoot: {
                        type: 'boolean',
                        description: 'Include root joints when inspecting skeletons, default true'
                    }
                },
                required: ['action']
            }
        };
    }

    async execute(args = {}) {
        switch (args.action) {
            case 'create':
                return await this.createMask(args);
            case 'query':
                return await this.queryMask(args);
            case 'set_joint':
                return await this.setJoint(args);
            case 'batch_set_joints':
                return await this.batchSetJoints(args);
            case 'remove_joint':
                return await this.removeJoint(args);
            case 'clear':
                return await this.clearMask(args);
            case 'list':
                return await this.listMasks(args);
            case 'inspect_skeleton':
                return await this.inspectSkeleton(args);
            case 'validate_paths':
                return await this.validatePaths(args);
            case 'skeleton_path_normalize':
                return await this.normalizeSkeletonPaths(args);
            case 'source_adapters':
                return this.getSourceAdapters();
            default:
                return {
                    success: false,
                    error: `Unknown animation_mask action: ${args.action}`
                };
        }
    }

    async createMask(args) {
        const url = this.normalizeMaskUrl(this.requireString(args.url, 'url'));
        const source = await this.resolveAssetSource(url, false);
        if (fs.existsSync(source) && !args.overwrite) {
            return {
                success: false,
                error: `Animation mask already exists: ${url}. Pass overwrite:true to replace it.`
            };
        }

        const joints = this.normalizeJoints(args.joints || []);
        const mask = this.buildMaskDocument({
            root: this.createRoot(args.name || ''),
            joints
        });

        await this.writeMaskFile(source, mask);
        await this.ensureMeta(source);
        await this.refreshAsset(url);

        return {
            success: true,
            data: {
                url,
                source,
                jointCount: joints.length,
                disabledCount: joints.filter((joint) => !joint.enabled).length
            },
            message: `Animation mask created: ${url}`
        };
    }

    async queryMask(args) {
        const url = this.normalizeMaskUrl(this.requireString(args.url, 'url'));
        const source = await this.resolveAssetSource(url, true);
        const document = this.readMaskFile(source);
        return {
            success: true,
            data: {
                url,
                source,
                name: document.root._name || '',
                jointCount: document.joints.length,
                enabledCount: document.joints.filter((joint) => joint.enabled).length,
                disabledCount: document.joints.filter((joint) => !joint.enabled).length,
                joints: document.joints
            }
        };
    }

    async setJoint(args) {
        const jointPath = this.requireString(args.path, 'path');
        if (typeof args.enabled !== 'boolean') {
            throw new Error('enabled must be a boolean');
        }
        return await this.batchSetJoints({
            ...args,
            joints: [{ path: jointPath, enabled: args.enabled }]
        });
    }

    async batchSetJoints(args) {
        const url = this.normalizeMaskUrl(this.requireString(args.url, 'url'));
        const source = await this.resolveAssetSource(url, false);
        const createIfMissing = args.createIfMissing !== false;
        const document = fs.existsSync(source)
            ? this.readMaskFile(source)
            : { root: this.createRoot(args.name || ''), joints: [] };

        if (!fs.existsSync(source) && !createIfMissing) {
            return {
                success: false,
                error: `Animation mask does not exist: ${url}`
            };
        }

        const updates = this.normalizeJoints(args.joints || []);
        const jointMap = new Map(document.joints.map((joint) => [joint.path, joint]));
        for (const update of updates) {
            jointMap.set(update.path, update);
        }

        const joints = Array.from(jointMap.values());
        const mask = this.buildMaskDocument({ root: document.root, joints });
        await this.writeMaskFile(source, mask);
        await this.ensureMeta(source);
        await this.refreshAsset(url);

        return {
            success: true,
            data: {
                url,
                source,
                updatedCount: updates.length,
                jointCount: joints.length,
                disabledCount: joints.filter((joint) => !joint.enabled).length
            },
            message: `Animation mask updated: ${url}`
        };
    }

    async removeJoint(args) {
        const url = this.normalizeMaskUrl(this.requireString(args.url, 'url'));
        const jointPath = this.requireString(args.path, 'path');
        const source = await this.resolveAssetSource(url, true);
        const document = this.readMaskFile(source);
        const before = document.joints.length;
        const joints = document.joints.filter((joint) => joint.path !== jointPath);
        const removed = before - joints.length;

        const mask = this.buildMaskDocument({ root: document.root, joints });
        await this.writeMaskFile(source, mask);
        await this.refreshAsset(url);

        return {
            success: true,
            data: { url, source, removed, jointCount: joints.length },
            message: removed ? `Joint removed from animation mask: ${jointPath}` : `Joint path not found: ${jointPath}`
        };
    }

    async clearMask(args) {
        const url = this.normalizeMaskUrl(this.requireString(args.url, 'url'));
        const source = await this.resolveAssetSource(url, true);
        const document = this.readMaskFile(source);
        const mask = this.buildMaskDocument({ root: document.root, joints: [] });
        await this.writeMaskFile(source, mask);
        await this.refreshAsset(url);

        return {
            success: true,
            data: { url, source, jointCount: 0 },
            message: `Animation mask cleared: ${url}`
        };
    }

    async listMasks(args) {
        const folderUrl = this.normalizeFolderUrl(args.folder || 'db://assets');
        const folder = await this.resolveDbUrlToPath(folderUrl);
        const masks = [];
        if (fs.existsSync(folder)) {
            this.walk(folder, (file) => {
                if (file.endsWith('.animask')) {
                    const url = this.pathToDbUrl(file);
                    let jointCount = 0;
                    try {
                        jointCount = this.readMaskFile(file).joints.length;
                    } catch (_) {}
                    masks.push({ url, source: file, jointCount });
                }
            });
        }

        return {
            success: true,
            data: {
                folder: folderUrl,
                count: masks.length,
                masks
            }
        };
    }

    async inspectSkeleton(args) {
        const sourceType = this.normalizeSourceType(args);
        const inspection = await this.inspectSkeletonSource(sourceType, args);
        const joints = this.buildJointDetails(inspection.paths, args.includeRoot !== false);

        return {
            success: true,
            data: {
                sourceType,
                source: inspection.source,
                adapter: inspection.adapter,
                roots: this.getRootNames(joints),
                jointCount: joints.length,
                joints
            }
        };
    }

    async validatePaths(args) {
        const paths = this.normalizePathList(args.paths || (args.path ? [args.path] : []));
        if (paths.length === 0) {
            throw new Error('paths or path is required');
        }

        const sourceType = this.normalizeSourceType(args);
        const inspection = await this.inspectSkeletonSource(sourceType, args);
        const sourcePaths = new Set(this.normalizePathList(inspection.paths));
        const rootNames = args.rootName ? [args.rootName] : this.getRootNamesFromPaths(inspection.paths);
        const valid = [];
        const invalid = [];

        for (const input of paths) {
            const normalized = this.normalizeSkeletonPath(input, { rootNames });
            const item = { input, normalized };
            if (sourcePaths.has(normalized)) {
                valid.push(item);
            } else {
                invalid.push(item);
            }
        }

        return {
            success: true,
            data: {
                sourceType,
                source: inspection.source,
                total: paths.length,
                validCount: valid.length,
                invalidCount: invalid.length,
                valid,
                invalid
            }
        };
    }

    async normalizeSkeletonPaths(args) {
        const paths = this.normalizePathList(args.paths || (args.path ? [args.path] : []));
        if (paths.length === 0) {
            throw new Error('paths or path is required');
        }

        let rootNames = args.rootName ? [args.rootName] : [];
        if (rootNames.length === 0 && args.sourceType) {
            const sourceType = this.normalizeSourceType(args);
            const inspection = await this.inspectSkeletonSource(sourceType, args);
            rootNames = this.getRootNamesFromPaths(inspection.paths);
        }

        const mappings = paths.map((input) => ({
            input,
            normalized: this.normalizeSkeletonPath(input, { rootNames })
        }));

        return {
            success: true,
            data: {
                rootNames,
                count: mappings.length,
                paths: mappings.map((item) => item.normalized),
                mappings
            }
        };
    }

    getSourceAdapters() {
        return {
            success: true,
            data: {
                adapters: [
                    {
                        sourceType: 'node',
                        status: 'supported',
                        inputs: ['node'],
                        description: 'Read a live scene node hierarchy through Editor.Message scene execution.'
                    },
                    {
                        sourceType: 'prefab',
                        status: 'supported',
                        inputs: ['prefabUrl', 'sourceUrl', 'url'],
                        description: 'Read serialized prefab/node JSON and extract hierarchy paths.'
                    },
                    {
                        sourceType: 'model',
                        status: 'supported',
                        inputs: ['modelUrl', 'sourceUrl', 'url'],
                        description: 'Read Cocos imported model metadata and prefer its redirected prefab hierarchy.'
                    }
                ]
            }
        };
    }

    normalizeSourceType(args) {
        if (args.sourceType) {
            return this.requireString(args.sourceType, 'sourceType');
        }
        if (args.node) {
            return 'node';
        }
        const url = args.prefabUrl || args.modelUrl || args.sourceUrl || args.url || '';
        if (/\.prefab$/i.test(url)) {
            return 'prefab';
        }
        if (url) {
            return 'model';
        }
        throw new Error('sourceType is required when source cannot be inferred');
    }

    async inspectSkeletonSource(sourceType, args) {
        switch (sourceType) {
            case 'node':
                return await this.inspectNodeSkeleton(args);
            case 'prefab':
                return await this.inspectPrefabSkeleton(args);
            case 'model':
                return await this.inspectModelSkeleton(args);
            default:
                throw new Error(`Unsupported skeleton sourceType: ${sourceType}`);
        }
    }

    async inspectNodeSkeleton(args) {
        const node = this.requireString(args.node, 'node');
        if (!this.canUseEditorMessage()) {
            throw new Error('sourceType=node requires Cocos Editor.Message');
        }

        const script = `
(() => {
  const target = ${JSON.stringify(node)};
  const rootName = ${JSON.stringify(args.rootName || '')};
  const scene = typeof cc !== 'undefined' && cc.director && cc.director.getScene ? cc.director.getScene() : null;
  if (!scene) return { success: false, error: 'Scene is not available' };
  const childrenOf = (node) => node.children || node._children || [];
  const nameOf = (node) => node.name || node._name || '';
  const uuidOf = (node) => node.uuid || node._uuid || '';
  const find = (current, parts, index) => {
    if (!current) return null;
    if (index >= parts.length) return current;
    for (const child of childrenOf(current)) {
      if (nameOf(child) === parts[index]) {
        const found = find(child, parts, index + 1);
        if (found) return found;
      }
    }
    return null;
  };
  const findByUuid = (current, uuid) => {
    if (!current) return null;
    if (uuidOf(current) === uuid) return current;
    for (const child of childrenOf(current)) {
      const found = findByUuid(child, uuid);
      if (found) return found;
    }
    return null;
  };
  const normalizedTarget = target.replace(/\\\\/g, '/').replace(/^\\/+|\\/+$/g, '');
  const start = findByUuid(scene, target) || find(scene, normalizedTarget.split('/').filter(Boolean), 0);
  if (!start) return { success: false, error: 'Node not found: ' + target };
  const paths = [];
  const walk = (current, prefix) => {
    const currentName = nameOf(current);
    const path = prefix ? prefix + '/' + currentName : currentName;
    const components = current.components || current._components || [];
    if ((current !== start || currentName === rootName) && (components.length === 0 || childrenOf(current).length > 0)) {
      paths.push(path);
    }
    for (const child of childrenOf(current)) {
      walk(child, path);
    }
  };
  walk(start, '');
  const stripRoot = (value) => {
    const parts = value.split('/').filter(Boolean);
    const index = rootName ? parts.indexOf(rootName) : -1;
    return index >= 0 ? parts.slice(index).join('/') : value;
  };
  return { success: true, paths: paths.map(stripRoot), node: target };
})()
`;
        const result = await this.executeSceneScript(script);
        if (!result || result.success === false) {
            throw new Error((result && result.error) || `Failed to inspect node skeleton: ${node}`);
        }

        return {
            adapter: 'node',
            source: node,
            paths: result.paths || []
        };
    }

    async inspectPrefabSkeleton(args) {
        const url = this.requireString(args.prefabUrl || args.sourceUrl || args.url, 'prefabUrl');
        const source = await this.resolveAssetSource(url, true);
        const paths = this.readSerializedNodePaths(source);
        return {
            adapter: 'prefab',
            source: url,
            paths
        };
    }

    async inspectModelSkeleton(args) {
        const url = this.requireString(args.modelUrl || args.sourceUrl || args.url, 'modelUrl');
        const source = await this.resolveAssetSource(url, true);
        const metaPath = `${source}.meta`;
        if (!fs.existsSync(metaPath)) {
            throw new Error(`Model meta not found: ${url}`);
        }

        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const redirect = meta && meta.userData && meta.userData.redirect;
        if (redirect) {
            const prefabSource = this.resolveLibraryJsonByUuid(redirect);
            if (prefabSource && fs.existsSync(prefabSource)) {
                return {
                    adapter: 'model:redirected-prefab',
                    source: url,
                    paths: this.readSerializedNodePaths(prefabSource)
                };
            }
        }

        const skeletons = meta && meta.userData && meta.userData.assetFinder && meta.userData.assetFinder.skeletons || [];
        const paths = [];
        for (const uuid of skeletons) {
            const skeletonSource = this.resolveLibraryJsonByUuid(uuid);
            if (!skeletonSource || !fs.existsSync(skeletonSource)) {
                continue;
            }
            const skeleton = JSON.parse(fs.readFileSync(skeletonSource, 'utf8'));
            if (Array.isArray(skeleton._joints)) {
                paths.push(...skeleton._joints);
            }
        }

        return {
            adapter: 'model:skeleton-json',
            source: url,
            paths
        };
    }

    async executeSceneScript(script) {
        const attempts = [
            () => Editor.Message.request('scene', 'execute-scene-script', { script }),
            () => Editor.Message.request('scene', 'execute-scene-script', script)
        ];
        for (const attempt of attempts) {
            try {
                return await attempt();
            } catch (_) {}
        }
        throw new Error('Failed to execute scene script');
    }

    readSerializedNodePaths(source) {
        const raw = fs.readFileSync(source, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }

        const rootRef = parsed[0] && parsed[0].data && parsed[0].data.__id__;
        const rootIndex = typeof rootRef === 'number'
            ? rootRef
            : parsed.findIndex((entry) => entry && entry.__type__ === 'cc.Node');
        if (rootIndex < 0) {
            return [];
        }

        const paths = [];
        const visit = (nodeIndex, prefix, includeCurrent) => {
            const node = parsed[nodeIndex];
            if (!node || node.__type__ !== 'cc.Node') {
                return;
            }
            const name = node._name || '';
            const currentPath = prefix ? `${prefix}/${name}` : name;
            if (includeCurrent && name) {
                paths.push(currentPath);
            }
            for (const childRef of node._children || []) {
                if (childRef && typeof childRef.__id__ === 'number') {
                    visit(childRef.__id__, includeCurrent ? currentPath : '', true);
                }
            }
        };
        visit(rootIndex, '', false);
        return paths;
    }

    buildJointDetails(paths, includeRoot) {
        const normalized = this.normalizePathList(paths);
        const filtered = includeRoot
            ? normalized
            : normalized.filter((item) => item.includes('/'));
        const unique = Array.from(new Set(filtered)).sort((left, right) => {
            const leftDepth = left.split('/').length;
            const rightDepth = right.split('/').length;
            return leftDepth === rightDepth ? left.localeCompare(right) : leftDepth - rightDepth;
        });
        const directChildCounts = new Map(unique.map((item) => [item, 0]));

        for (const item of unique) {
            const parent = item.split('/').slice(0, -1).join('/');
            if (directChildCounts.has(parent)) {
                directChildCounts.set(parent, directChildCounts.get(parent) + 1);
            }
        }

        return unique.map((item) => {
            const segments = item.split('/');
            return {
                name: segments[segments.length - 1],
                path: item,
                depth: segments.length - 1,
                childrenCount: directChildCounts.get(item) || 0
            };
        });
    }

    normalizePathList(paths) {
        if (!Array.isArray(paths)) {
            throw new Error('paths must be an array');
        }
        return paths
            .filter((item) => typeof item === 'string' && item.trim())
            .map((item) => item.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
            .filter(Boolean);
    }

    normalizeSkeletonPath(input, options = {}) {
        const clean = this.normalizePathList([input])[0] || '';
        const rootNames = (options.rootNames || [])
            .filter((item) => typeof item === 'string' && item.trim())
            .map((item) => item.trim());
        if (rootNames.length === 0) {
            return clean;
        }

        const segments = clean.split('/').filter(Boolean);
        for (const rootName of rootNames) {
            const index = segments.indexOf(rootName);
            if (index >= 0) {
                return segments.slice(index).join('/');
            }
        }
        return clean;
    }

    getRootNames(joints) {
        return Array.from(new Set(joints.map((joint) => joint.path.split('/')[0]).filter(Boolean)));
    }

    getRootNamesFromPaths(paths) {
        return Array.from(new Set(this.normalizePathList(paths).map((item) => item.split('/')[0]).filter(Boolean)));
    }

    resolveLibraryJsonByUuid(uuid) {
        if (typeof uuid !== 'string' || !uuid.trim()) {
            return null;
        }
        const clean = uuid.trim();
        const libraryPath = path.join(this.getProjectPath(), 'library');
        return path.join(libraryPath, clean.slice(0, 2), `${clean}.json`);
    }

    readMaskFile(source) {
        const raw = fs.readFileSync(source, 'utf8');
        const parsed = JSON.parse(raw);

        if (Array.isArray(parsed)) {
            const root = { ...(parsed[0] || this.createRoot('')) };
            const joints = (root._jointMasks || [])
                .map((ref) => parsed[ref && ref.__id__])
                .filter(Boolean)
                .map((entry) => this.normalizeJoint(entry));
            root._jointMasks = [];
            return { root, joints };
        }

        const root = { ...(parsed || this.createRoot('')) };
        const joints = Array.isArray(root._jointMasks)
            ? root._jointMasks
                .filter((entry) => entry && typeof entry.path === 'string')
                .map((entry) => this.normalizeJoint(entry))
            : [];
        root._jointMasks = [];
        return { root, joints };
    }

    buildMaskDocument({ root, joints }) {
        const cleanRoot = {
            __type__: 'cc.animation.AnimationMask',
            _name: '',
            _objFlags: 0,
            _native: '',
            ...root
        };

        const cleanJoints = this.normalizeJoints(joints);
        if (cleanJoints.length === 0) {
            delete cleanRoot.__editorExtras__;
            cleanRoot._jointMasks = [];
            return cleanRoot;
        }

        cleanRoot.__editorExtras__ = cleanRoot.__editorExtras__ || {};
        cleanRoot._jointMasks = cleanJoints.map((_, index) => ({ __id__: index + 1 }));
        return [
            cleanRoot,
            ...cleanJoints.map((joint) => ({
                __type__: 'cc.JointMask',
                path: joint.path,
                enabled: joint.enabled
            }))
        ];
    }

    createRoot(name) {
        return {
            __type__: 'cc.animation.AnimationMask',
            _name: name || '',
            _objFlags: 0,
            _native: '',
            _jointMasks: []
        };
    }

    normalizeJoints(joints) {
        if (!Array.isArray(joints)) {
            throw new Error('joints must be an array');
        }
        return joints.map((joint) => this.normalizeJoint(joint));
    }

    normalizeJoint(joint) {
        if (!joint || typeof joint.path !== 'string' || !joint.path.trim()) {
            throw new Error(`Invalid joint entry: ${JSON.stringify(joint)}`);
        }
        return {
            path: joint.path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
            enabled: joint.enabled !== false
        };
    }

    async resolveAssetSource(url, mustExist) {
        let source = null;
        if (this.canUseEditorMessage()) {
            try {
                const info = await Editor.Message.request('asset-db', 'query-asset-info', url);
                source = this.pickAssetSource(info);
            } catch (_) {}
        }
        source = source || await this.resolveDbUrlToPath(url);
        if (mustExist && !fs.existsSync(source)) {
            throw new Error(`Animation mask not found: ${url}`);
        }
        return source;
    }

    pickAssetSource(info) {
        if (!info) {
            return null;
        }
        for (const candidate of [info.source, info.file, info.path]) {
            if (typeof candidate !== 'string' || !candidate.trim()) {
                continue;
            }
            if (candidate.startsWith('db://')) {
                continue;
            }
            return candidate;
        }
        return null;
    }

    async resolveDbUrlToPath(url) {
        if (!url.startsWith('db://assets')) {
            throw new Error(`Only db://assets URLs are supported: ${url}`);
        }
        const projectPath = this.getProjectPath();
        const relative = url.slice('db://assets'.length).replace(/^\/+/, '');
        return path.join(projectPath, 'assets', ...relative.split('/').filter(Boolean));
    }

    pathToDbUrl(file) {
        const assetsRoot = path.join(this.getProjectPath(), 'assets');
        const relative = path.relative(assetsRoot, file).split(path.sep).join('/');
        return `db://assets/${relative}`;
    }

    getProjectPath() {
        if (global.Editor && Editor.Project && Editor.Project.path) {
            return Editor.Project.path;
        }
        let current = process.cwd();
        for (let index = 0; index < 8; index++) {
            const packagePath = path.join(current, 'package.json');
            const assetsPath = path.join(current, 'assets');
            if (fs.existsSync(packagePath) && fs.existsSync(assetsPath)) {
                try {
                    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
                    if (pkg.creator) {
                        return current;
                    }
                } catch (_) {}
            }
            const parent = path.dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }
        return path.resolve(__dirname, '../../../../../../..');
    }

    async writeMaskFile(source, mask) {
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.writeFileSync(source, JSON.stringify(mask, null, 2), 'utf8');
    }

    async ensureMeta(source) {
        const metaPath = `${source}.meta`;
        if (fs.existsSync(metaPath)) {
            return;
        }
        const meta = {
            ver: '0.0.1',
            importer: 'animation-mask',
            imported: true,
            uuid: uuidv4(),
            files: ['.json'],
            subMetas: {},
            userData: {}
        };
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    }

    async refreshAsset(url) {
        if (!this.canUseEditorMessage()) {
            return;
        }
        const attempts = [
            () => Editor.Message.request('asset-db', 'refresh-asset', url),
            () => Editor.Message.request('asset-db', 'refresh', url),
            () => Editor.Message.request('asset-db', 'reimport-asset', url)
        ];
        for (const attempt of attempts) {
            try {
                await attempt();
                return;
            } catch (_) {}
        }
    }

    canUseEditorMessage() {
        return !!(global.Editor && Editor.Message && typeof Editor.Message.request === 'function');
    }

    normalizeMaskUrl(url) {
        const clean = this.normalizeFolderUrl(url);
        return clean.endsWith('.animask') ? clean : `${clean}.animask`;
    }

    normalizeFolderUrl(url) {
        const clean = this.requireString(url, 'url').replace(/\\/g, '/').replace(/\/+$/g, '');
        if (!clean.startsWith('db://assets')) {
            throw new Error(`Only db://assets URLs are supported: ${clean}`);
        }
        return clean;
    }

    requireString(value, name) {
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error(`${name} is required`);
        }
        return value.trim();
    }

    walk(dir, visitor) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this.walk(full, visitor);
            } else {
                visitor(full);
            }
        }
    }
}

module.exports = { AnimationMaskHandler };
