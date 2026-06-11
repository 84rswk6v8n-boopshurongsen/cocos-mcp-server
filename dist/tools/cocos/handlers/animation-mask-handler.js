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
                'Actions: create, query, set_joint, batch_set_joints, remove_joint, clear, list.',
                'Example: {action:"batch_set_joints", url:"db://assets/masks/UpperBody.animask", joints:[{path:"Root/Spine", enabled:true}]}'
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['create', 'query', 'set_joint', 'batch_set_joints', 'remove_joint', 'clear', 'list'],
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
