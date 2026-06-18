'use strict';

const fs = require('fs');
const path = require('path');
const { NodeHandler } = require('./node-handler');
const { ComponentHandler } = require('./component-handler');
const { PrefabHandler } = require('./prefab-handler');
const { MaterialHandler } = require('./material-handler');

const ACTIONS = [
    'list',
    'inspect',
    'create',
    'instantiate',
    'set_property',
    'assign_asset',
    'delete',
    'validate'
];

const TYPE_TO_COMPONENT = {
    particle3d: 'cc.ParticleSystem',
    particle2d: 'cc.ParticleSystem2D',
    motion_streak: 'cc.MotionStreak',
    line: 'cc.Line',
    billboard: 'cc.Billboard'
};

const VFX_COMPONENTS = new Set(Object.values(TYPE_TO_COMPONENT));
const VFX_COMPONENT_RE = /(ParticleSystem|ParticleSystem2D|MotionStreak|Line|Billboard|Trail|Effect|Decal)/i;
const VFX_ASSET_RE = /\.(prefab|mtl|effect|png|jpg|jpeg|tga|webp|bmp)$/i;
const IMAGE_RE = /\.(png|jpg|jpeg|tga|webp|bmp)$/i;
const PROPERTY_KEEP_LIST = [
    'enabled',
    '_enabled',
    'duration',
    'life',
    'lifeVar',
    'loop',
    'playOnLoad',
    'autoRemoveOnFinish',
    'totalParticles',
    'capacity',
    'emissionRate',
    'startColor',
    'endColor',
    'startSize',
    'endSize',
    'startSpeed',
    'gravity',
    'angle',
    'angleVar',
    'startRadius',
    'endRadius',
    'positionType',
    'renderMode',
    'simulationSpace',
    'material',
    'sharedMaterial',
    'materials',
    'customMaterial',
    'texture',
    'spriteFrame'
];

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

function toDbUrl(value, fallbackFolder, ext) {
    if (!value) {
        return null;
    }
    const text = normalizeSlash(value);
    if (text.startsWith('db://')) {
        return text;
    }
    if (text.startsWith('assets/')) {
        return `db://${text}`;
    }
    if (text.startsWith('/assets/')) {
        return `db://${text.slice(1)}`;
    }
    const folder = fallbackFolder || 'db://assets';
    const fileName = ext && !text.toLowerCase().endsWith(ext) ? `${text}${ext}` : text;
    return `${folder.replace(/\/$/, '')}/${fileName.replace(/^\/+/, '')}`;
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
    if (!relative || relative.startsWith('..')) {
        return null;
    }
    return `db://assets/${normalizeSlash(relative)}`;
}

function walkFiles(root, predicate, maxFiles) {
    const output = [];
    const limit = Number(maxFiles) || 2000;
    function walk(dir) {
        if (!dir || output.length >= limit || !fs.existsSync(dir)) {
            return;
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'library' || entry.name === 'temp') {
                continue;
            }
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            }
            else if (!predicate || predicate(fullPath)) {
                output.push(fullPath);
                if (output.length >= limit) {
                    return;
                }
            }
        }
    }
    walk(root);
    return output;
}

function extractData(result) {
    return result && Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : result;
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function getComponentsFromResult(result) {
    const data = extractData(result);
    if (Array.isArray(data)) {
        return data;
    }
    return asArray(data && data.components);
}

function getNodesFromList(result) {
    const data = extractData(result);
    if (Array.isArray(data)) {
        return data;
    }
    if (Array.isArray(data && data.nodes)) {
        return data.nodes;
    }
    if (Array.isArray(data && data.items)) {
        return data.items;
    }
    return [];
}

function flattenNodeTree(value, output = []) {
    if (!value) {
        return output;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            flattenNodeTree(item, output);
        }
        return output;
    }
    if (typeof value !== 'object') {
        return output;
    }
    output.push(value);
    const children = value.children || value.childNodes || value.nodes;
    if (Array.isArray(children)) {
        for (const child of children) {
            flattenNodeTree(child, output);
        }
    }
    return output;
}

function componentTypeOf(component) {
    return component && (component.type || component.name || component.componentType || component.__type__ || '');
}

function isVfxComponentType(type) {
    const text = String(type || '');
    return VFX_COMPONENTS.has(text) || VFX_COMPONENT_RE.test(text);
}

function propValue(component, name) {
    const props = component && component.properties;
    if (!props || !Object.prototype.hasOwnProperty.call(props, name)) {
        return undefined;
    }
    const prop = props[name];
    if (prop && typeof prop === 'object' && Object.prototype.hasOwnProperty.call(prop, 'value')) {
        return prop.value;
    }
    return prop;
}

function compactValue(value, depth = 0) {
    if (depth > 3) {
        return '[MaxDepth]';
    }
    if (value === null || value === undefined || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.slice(0, 16).map((item) => compactValue(item, depth + 1));
    }
    if (value.uuid || value.__uuid__) {
        return { uuid: value.uuid || value.__uuid__ };
    }
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 24)) {
        if (typeof item === 'function') {
            continue;
        }
        output[key] = compactValue(item, depth + 1);
    }
    return output;
}

function compactProperties(component, includeProperties) {
    if (!includeProperties) {
        return undefined;
    }
    const output = {};
    for (const key of PROPERTY_KEEP_LIST) {
        const value = propValue(component, key);
        if (value !== undefined) {
            output[key] = compactValue(value);
        }
    }
    return output;
}

function summarizeComponent(component, includeProperties) {
    return {
        type: componentTypeOf(component),
        uuid: component && component.uuid,
        enabled: component && Object.prototype.hasOwnProperty.call(component, 'enabled') ? component.enabled : propValue(component, 'enabled'),
        properties: compactProperties(component, includeProperties)
    };
}

function extractInstantiatedNode(result) {
    const data = extractData(result) || {};
    if (typeof data === 'string') {
        return data;
    }
    return data.uuid
        || data.nodeUuid
        || data.nodeId
        || (data.node && (data.node.uuid || data.node.nodeUuid || data.node.name))
        || data.name
        || null;
}

function readTextIfExists(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            return null;
        }
        return fs.readFileSync(filePath, 'utf8');
    }
    catch (_) {
        return null;
    }
}

function scanPrefabText(text) {
    if (!text) {
        return { vfxComponents: [], materialRefs: [], textureRefs: [] };
    }
    const vfxComponents = Array.from(new Set((text.match(/cc\.(?:ParticleSystem2D|ParticleSystem|MotionStreak|Line|Billboard|TrailRenderer)/g) || [])));
    const materialRefs = Array.from(new Set((text.match(/db:\/\/assets\/[^"']+\.mtl/g) || []))).slice(0, 64);
    const textureRefs = Array.from(new Set((text.match(/db:\/\/assets\/[^"']+\.(?:png|jpg|jpeg|tga|webp|bmp)/gi) || []))).slice(0, 64);
    return { vfxComponents, materialRefs, textureRefs };
}

class VfxHandler {
    constructor() {
        this.node = new NodeHandler();
        this.component = new ComponentHandler();
        this.prefab = new PrefabHandler();
        this.material = new MaterialHandler();
    }

    getToolDefinition() {
        return {
            name: 'vfx',
            description: 'VFX/粒子效果编辑工具：查看、新建、实例化、编辑、绑定资源、删除和校验编辑器内特效节点。第一阶段只处理编辑器场景/预制体资源，不做运行态调试和美术预设。',
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ACTIONS,
                        description: '操作：list、inspect、create、instantiate、set_property、assign_asset、delete、validate'
                    },
                    scope: {
                        type: 'string',
                        enum: ['scene', 'assets', 'all'],
                        description: 'list 范围，默认 all'
                    },
                    type: {
                        type: 'string',
                        enum: ['particle3d', 'particle2d', 'motion_streak', 'line', 'billboard'],
                        description: 'create 时的新建类型'
                    },
                    node: { type: 'string', description: '场景节点名、路径或 UUID' },
                    name: { type: 'string', description: '新节点名称或实例化后的节点名称' },
                    parent: { type: 'string', description: '父节点名、路径或 UUID，默认场景根或 Canvas' },
                    rootNode: { type: 'string', description: '扫描场景 VFX 节点的根节点' },
                    folder: { type: 'string', description: '资源扫描目录，默认 db://assets/vfx；不存在时回退到 db://assets' },
                    prefabUrl: { type: 'string', description: 'VFX 预制体资源 db:// 路径' },
                    prefabPath: { type: 'string', description: 'prefabUrl 的兼容别名' },
                    componentType: { type: 'string', description: '组件类型，例如 cc.ParticleSystem 或 cc.ParticleSystem2D' },
                    property: { type: 'string', description: '要设置或绑定的组件属性名' },
                    value: { description: '属性值' },
                    properties: { type: 'object', description: '批量属性，透传给 cocos_component.set_property' },
                    propertyType: {
                        type: 'string',
                        enum: ['string', 'number', 'boolean', 'integer', 'float', 'color', 'vec2', 'vec3', 'size', 'node', 'component', 'spriteFrame', 'prefab', 'asset', 'nodeArray', 'componentArray', 'colorArray', 'numberArray', 'stringArray'],
                        description: '属性类型，不填则由底层工具自动推断'
                    },
                    materialUrl: { type: 'string', description: '要绑定的材质 db:// 路径' },
                    textureUrl: { type: 'string', description: '要绑定的贴图 db:// 路径；需要同时指定 property' },
                    spriteFrameUrl: { type: 'string', description: '要绑定的 SpriteFrame db:// 路径；需要同时指定 property' },
                    slot: { type: 'number', description: '材质槽下标，默认 0' },
                    deleteMode: {
                        type: 'string',
                        enum: ['node', 'component'],
                        description: 'delete 必填：node 删除节点，component 只删除组件'
                    },
                    position: { type: 'object', description: '位置 {x,y,z}' },
                    rotation: { type: 'object', description: '旋转 {x,y,z}' },
                    scale: { type: 'object', description: '缩放 {x,y,z}' },
                    includeMaterials: { type: 'boolean', description: 'inspect 时是否读取渲染材质槽' },
                    includeProperties: { type: 'boolean', description: '是否返回精简组件属性' },
                    maxNodes: { type: 'number', description: '场景扫描节点上限，默认 300' },
                    maxFiles: { type: 'number', description: '资源扫描文件上限，默认 1000' }
                },
                required: ['action']
            }
        };
    }

    async execute(args = {}) {
        try {
            switch (args.action) {
                case 'list':
                    return await this.list(args);
                case 'inspect':
                    return await this.inspect(args);
                case 'create':
                    return await this.create(args);
                case 'instantiate':
                    return await this.instantiate(args);
                case 'set_property':
                    return await this.setProperty(args);
                case 'assign_asset':
                    return await this.assignAsset(args);
                case 'delete':
                    return await this.delete(args);
                case 'validate':
                    return await this.validate(args);
                default:
                    return fail(`未知 VFX 操作：${args.action}。可用操作：${ACTIONS.join(', ')}`);
            }
        }
        catch (error) {
            return fail(`VFX 工具执行失败：${error && error.message ? error.message : String(error)}`);
        }
    }

    async list(args) {
        const scope = args.scope || 'all';
        const data = {};
        if (scope === 'scene' || scope === 'all') {
            data.scene = await this.listSceneVfx(args);
        }
        if (scope === 'assets' || scope === 'all') {
            data.assets = this.listAssetVfx(args);
        }
        return ok(data, 'VFX 列表获取完成。');
    }

    async listSceneVfx(args) {
        const maxNodes = Number(args.maxNodes) || 300;
        const nodeResult = await this.node.execute(args.rootNode
            ? { action: 'tree', node: args.rootNode, maxDepth: 20 }
            : { action: 'list' });
        if (!nodeResult || nodeResult.success === false) {
            return {
                success: false,
                error: nodeResult && nodeResult.error ? nodeResult.error : '读取场景节点失败。'
            };
        }
        const rawNodes = args.rootNode ? flattenNodeTree(extractData(nodeResult)) : getNodesFromList(nodeResult);
        const nodes = rawNodes.slice(0, maxNodes);
        const items = [];
        for (const node of nodes) {
            const nodeKey = node.uuid || node.path || node.name || node.node;
            if (!nodeKey) {
                continue;
            }
            const compResult = await this.component.execute({ action: 'list', node: nodeKey });
            const components = getComponentsFromResult(compResult).filter((component) => isVfxComponentType(componentTypeOf(component)));
            if (components.length > 0) {
                items.push({
                    name: node.name,
                    uuid: node.uuid,
                    path: node.path,
                    active: node.active,
                    components: components.map((component) => summarizeComponent(component, false))
                });
            }
        }
        return {
            success: true,
            scanned: nodes.length,
            count: items.length,
            items
        };
    }

    listAssetVfx(args) {
        const requestedFolder = toDbUrl(args.folder || 'db://assets/vfx');
        let root = dbUrlToFilePath(requestedFolder);
        let folder = requestedFolder;
        if (!root || !fs.existsSync(root)) {
            folder = 'db://assets';
            root = dbUrlToFilePath(folder);
        }
        if (!root || !fs.existsSync(root)) {
            return { success: false, error: '没有找到 assets 目录。', folder };
        }
        const files = walkFiles(root, (file) => VFX_ASSET_RE.test(file), Number(args.maxFiles) || 1000);
        const prefabs = [];
        const materials = [];
        const effects = [];
        const textures = [];
        for (const file of files) {
            const url = filePathToDbUrl(file);
            if (!url) {
                continue;
            }
            const entry = {
                name: path.basename(file),
                url,
                size: fs.statSync(file).size
            };
            if (/\.prefab$/i.test(file)) {
                const scan = scanPrefabText(readTextIfExists(file));
                prefabs.push(Object.assign(entry, scan));
            }
            else if (/\.mtl$/i.test(file)) {
                materials.push(entry);
            }
            else if (/\.effect$/i.test(file)) {
                effects.push(entry);
            }
            else if (IMAGE_RE.test(file)) {
                textures.push(entry);
            }
        }
        return {
            success: true,
            folder,
            count: files.length,
            prefabs,
            materials,
            effects,
            textures
        };
    }

    async inspect(args) {
        const prefabUrl = toDbUrl(args.prefabUrl || args.prefabPath, args.folder || 'db://assets/vfx', '.prefab');
        if (prefabUrl) {
            return this.inspectPrefab(prefabUrl);
        }
        if (!args.node) {
            return fail('inspect 需要提供 node 或 prefabUrl。');
        }
        const infoResult = await this.node.execute({ action: 'info', node: args.node });
        if (!infoResult || infoResult.success === false) {
            return fail(infoResult && infoResult.error ? infoResult.error : `未找到节点：${args.node}`);
        }
        const compResult = await this.component.execute({ action: 'list', node: args.node });
        const allComponents = getComponentsFromResult(compResult);
        const vfxComponents = allComponents.filter((component) => isVfxComponentType(componentTypeOf(component)));
        const data = {
            node: extractData(infoResult),
            hasVfxComponent: vfxComponents.length > 0,
            vfxComponents: vfxComponents.map((component) => summarizeComponent(component, !!args.includeProperties)),
            components: allComponents.map((component) => summarizeComponent(component, false))
        };
        if (args.includeMaterials) {
            const materialResult = await this.material.execute({ action: 'inspect_renderer', node: args.node });
            data.materials = materialResult && materialResult.success === false
                ? { success: false, error: materialResult.error }
                : extractData(materialResult);
        }
        return ok(data, 'VFX 节点检查完成。');
    }

    inspectPrefab(prefabUrl) {
        const filePath = dbUrlToFilePath(prefabUrl);
        if (!filePath || !fs.existsSync(filePath)) {
            return fail(`未找到 VFX 预制体：${prefabUrl}`);
        }
        const text = readTextIfExists(filePath);
        return ok({
            prefabUrl,
            filePath,
            size: fs.statSync(filePath).size,
            scan: scanPrefabText(text)
        }, 'VFX 预制体检查完成。');
    }

    async create(args) {
        const componentType = args.componentType || TYPE_TO_COMPONENT[args.type || 'particle3d'];
        if (!componentType) {
            return fail('create 需要提供有效 type 或 componentType。');
        }
        const initialTransform = {};
        if (args.position) {
            initialTransform.position = args.position;
        }
        if (args.rotation) {
            initialTransform.rotation = args.rotation;
        }
        if (args.scale) {
            initialTransform.scale = args.scale;
        }
        const createResult = await this.node.execute({
            action: 'create',
            name: args.name || `VFX_${args.type || 'particle3d'}`,
            parent: args.parent,
            nodeType: '3D',
            components: [componentType],
            initialTransform
        });
        if (!createResult || createResult.success === false) {
            return createResult || fail('创建 VFX 节点失败。');
        }
        return ok({
            result: extractData(createResult),
            componentType
        }, 'VFX 节点已创建。');
    }

    async instantiate(args) {
        const prefabUrl = toDbUrl(args.prefabUrl || args.prefabPath, args.folder || 'db://assets/vfx', '.prefab');
        if (!prefabUrl) {
            return fail('instantiate 需要提供 prefabUrl。');
        }
        const result = await this.prefab.execute({
            action: 'instantiate',
            prefabPath: prefabUrl,
            parent: args.parent,
            position: args.position
        });
        if (!result || result.success === false) {
            return result || fail(`实例化 VFX 预制体失败：${prefabUrl}`);
        }
        const nodeKey = extractInstantiatedNode(result);
        const modifications = {};
        if (args.name) {
            modifications.name = args.name;
        }
        if (args.rotation) {
            modifications.rotation = args.rotation;
        }
        if (args.scale) {
            modifications.scale = args.scale;
        }
        if (nodeKey && Object.keys(modifications).length > 0) {
            await this.node.execute(Object.assign({ action: 'modify', node: nodeKey }, modifications));
        }
        return ok({
            prefabUrl,
            node: nodeKey,
            result: extractData(result)
        }, 'VFX 预制体已实例化。');
    }

    async setProperty(args) {
        if (!args.node) {
            return fail('set_property 需要提供 node。');
        }
        if (!args.property && !args.properties) {
            return fail('set_property 需要提供 property 或 properties。');
        }
        const componentType = await this.resolveVfxComponentType(args.node, args.componentType);
        if (!componentType) {
            return fail(`节点上没有可自动识别的 VFX 组件，请指定 componentType：${args.node}`);
        }
        const result = await this.component.execute({
            action: 'set_property',
            node: args.node,
            componentType,
            property: args.property,
            value: args.value,
            propertyType: args.propertyType,
            properties: args.properties
        });
        return result && result.success === false ? result : ok(extractData(result), 'VFX 组件属性已更新。');
    }

    async assignAsset(args) {
        if (!args.node) {
            return fail('assign_asset 需要提供 node。');
        }
        if (args.materialUrl) {
            const result = await this.material.execute({
                action: 'assign_material',
                node: args.node,
                componentType: args.componentType,
                materialUrl: toDbUrl(args.materialUrl, args.folder || 'db://assets/vfx', '.mtl'),
                slot: Number.isFinite(Number(args.slot)) ? Number(args.slot) : 0
            });
            return result && result.success === false ? result : ok(extractData(result), 'VFX 材质已绑定。');
        }
        if (args.prefabUrl || args.prefabPath) {
            return fail('prefabUrl 用于实例化特效，请使用 action: "instantiate"，不要通过 assign_asset 绑定预制体。');
        }
        const assetUrl = args.textureUrl || args.spriteFrameUrl;
        if (!assetUrl) {
            return fail('assign_asset 需要提供 materialUrl、textureUrl 或 spriteFrameUrl。');
        }
        if (!args.property) {
            return fail('绑定贴图或 SpriteFrame 时需要指定组件属性 property，避免绑定到错误字段。');
        }
        const propertyType = args.propertyType || (args.spriteFrameUrl ? 'spriteFrame' : 'asset');
        const componentType = await this.resolveVfxComponentType(args.node, args.componentType);
        if (!componentType) {
            return fail(`节点上没有可自动识别的 VFX 组件，请指定 componentType：${args.node}`);
        }
        const result = await this.component.execute({
            action: 'set_property',
            node: args.node,
            componentType,
            property: args.property,
            value: toDbUrl(assetUrl, args.folder || 'db://assets/vfx'),
            propertyType
        });
        return result && result.success === false ? result : ok(extractData(result), 'VFX 资源引用已绑定。');
    }

    async delete(args) {
        if (!args.node) {
            return fail('delete 需要提供 node。');
        }
        if (!args.deleteMode) {
            return fail('delete 需要显式提供 deleteMode：node 删除整个节点，component 只删除组件。');
        }
        if (args.deleteMode === 'node') {
            const result = await this.node.execute({ action: 'delete', node: args.node });
            return result && result.success === false ? result : ok(extractData(result), 'VFX 节点已删除。');
        }
        if (args.deleteMode === 'component') {
            const componentType = await this.resolveVfxComponentType(args.node, args.componentType);
            if (!componentType) {
                return fail(`节点上没有可自动识别的 VFX 组件，请指定 componentType：${args.node}`);
            }
            const result = await this.component.execute({ action: 'remove', node: args.node, componentType });
            return result && result.success === false ? result : ok(extractData(result), 'VFX 组件已删除。');
        }
        return fail(`未知 deleteMode：${args.deleteMode}`);
    }

    async resolveVfxComponentType(node, requestedType) {
        if (requestedType) {
            return requestedType;
        }
        const compResult = await this.component.execute({ action: 'list', node });
        const components = getComponentsFromResult(compResult);
        const found = components.find((component) => isVfxComponentType(componentTypeOf(component)));
        return found ? componentTypeOf(found) : null;
    }

    async validate(args) {
        const targets = [];
        if (args.node) {
            targets.push(args.node);
        }
        else {
            const scene = await this.listSceneVfx(args);
            if (scene && scene.items) {
                for (const item of scene.items) {
                    targets.push(item.uuid || item.path || item.name);
                }
            }
        }
        const warnings = [];
        const infos = [];
        for (const target of targets) {
            const inspect = await this.inspect({ node: target, includeProperties: true, includeMaterials: true });
            if (!inspect.success) {
                warnings.push({ node: target, message: inspect.error });
                continue;
            }
            const data = inspect.data;
            if (data.node && data.node.active === false) {
                warnings.push({ node: target, message: '节点当前未激活，特效不会显示。' });
            }
            if (!data.hasVfxComponent) {
                warnings.push({ node: target, message: '节点上没有识别到常见 VFX 组件。' });
            }
            for (const component of data.vfxComponents) {
                if (component.enabled === false) {
                    warnings.push({ node: target, component: component.type, message: '组件已禁用。' });
                }
                const count = component.properties && (component.properties.totalParticles || component.properties.capacity);
                if (Number(count) > 2000) {
                    warnings.push({ node: target, component: component.type, message: `粒子数量较高：${count}，移动端需要重点关注性能。` });
                }
            }
            infos.push({
                node: target,
                vfxComponentCount: data.vfxComponents.length,
                materialInfoAvailable: !!data.materials
            });
        }
        const assets = args.folder ? this.listAssetVfx(args) : null;
        return ok({
            checkedNodes: targets.length,
            warnings,
            infos,
            assets
        }, warnings.length > 0 ? 'VFX 校验完成，发现需要关注的问题。' : 'VFX 校验完成，未发现明显问题。');
    }
}

exports.VfxHandler = VfxHandler;
