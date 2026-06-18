'use strict';

const fs = require('fs');
const path = require('path');
const { ComponentHandler } = require('./component-handler');
const { NodeHandler } = require('./node-handler');

const ACTIONS = [
    'info',
    'list',
    'add_rigidbody',
    'add_collider',
    'set_rigidbody',
    'set_collider',
    'setup_trigger_zone',
    'setup_projectile_collision',
    'validate_physics',
    'list_collision_groups',
    'set_collision_group',
    'set_collision_mask',
    'inspect_physics_settings',
    'set_physics_debug',
    'validate_physics_scene',
    'create_physics_material',
    'assign_physics_material',
    'inspect_physics_material',
    'debug_draw_ray',
    'debug_draw_collider',
    'debug_draw_all_colliders',
    'debug_add_collider',
    'debug_clear_drawings',
    'debug_set_visibility',
    'register_runtime_ray',
    'report_runtime_ray',
    'list_runtime_rays',
    'watch_runtime_ray',
    'unwatch_runtime_ray',
    'clear_runtime_rays',
    'debug_draw_area',
    'register_runtime_area',
    'report_runtime_area',
    'list_runtime_areas',
    'watch_runtime_area',
    'unwatch_runtime_area',
    'clear_runtime_areas'
];

const RIGIDBODY_3D = 'cc.RigidBody';
const RIGIDBODY_2D = 'cc.RigidBody2D';
const COLLIDER_TYPES = {
    box: 'cc.BoxCollider',
    sphere: 'cc.SphereCollider',
    capsule: 'cc.CapsuleCollider',
    mesh: 'cc.MeshCollider',
    box2d: 'cc.BoxCollider2D',
    circle2d: 'cc.CircleCollider2D',
    polygon2d: 'cc.PolygonCollider2D'
};

const RIGIDBODY_TYPE_VALUES = {
    dynamic: 1,
    static: 2,
    kinematic: 4
};

function ok(data, message) {
    return { success: true, data, message };
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

function toDbUrl(assetUrl, fallbackFolder, fallbackExt) {
    if (assetUrl && String(assetUrl).startsWith('db://')) {
        return String(assetUrl);
    }
    if (assetUrl) {
        return `db://assets/${String(assetUrl).replace(/^\/+/, '')}`;
    }
    const folder = fallbackFolder || 'db://assets/physics';
    const name = `PhysicsMaterial_${Date.now()}${fallbackExt || '.physics-material'}`;
    return `${folder.replace(/\/$/, '')}/${name}`;
}

function dbUrlToFilePath(dbUrl) {
    const normalized = String(dbUrl || '').replace(/\\/g, '/');
    if (!normalized.startsWith('db://assets/')) {
        return null;
    }
    return path.join(projectRoot(), 'assets', normalized.slice('db://assets/'.length));
}

function readJsonIfExists(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            return null;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    catch (_) {
        return null;
    }
}

function fail(error, data) {
    return { success: false, error, data };
}

function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function propValue(component, name) {
    const props = component && component.properties;
    if (!props || !props[name]) {
        return undefined;
    }
    const prop = props[name];
    return Object.prototype.hasOwnProperty.call(prop, 'value') ? prop.value : prop;
}

function propMeta(component, name) {
    const props = component && component.properties;
    return props && props[name] ? props[name] : null;
}

function compactProperties(component) {
    const keys = [
        'enabled',
        '_enabled',
        'type',
        'mass',
        'useGravity',
        'linearDamping',
        'angularDamping',
        'allowSleep',
        'isTrigger',
        'center',
        'size',
        'radius',
        'cylinderHeight',
        'height',
        'direction',
        'group',
        'mask',
        'material',
        'sharedMaterial',
        'physicsMaterial'
    ];
    const output = {};
    for (const key of keys) {
        const value = propValue(component, key);
        if (value !== undefined) {
            output[key] = value;
        }
    }
    return output;
}

function componentType(component) {
    return (component && (component.type || component.name || component.componentType)) || '';
}

function isRigidbody(type) {
    return /RigidBody/i.test(type || '');
}

function isCollider(type) {
    return /Collider/i.test(type || '');
}

function simplifyComponent(component) {
    const type = componentType(component);
    return {
        type,
        uuid: component && component.uuid,
        enabled: component && component.enabled,
        category: isRigidbody(type) ? 'rigidbody' : isCollider(type) ? 'collider' : 'other',
        properties: compactProperties(component)
    };
}

function normalizeEnumList(meta) {
    const list = meta && (meta.enumList || meta.enum || meta.enums);
    if (!Array.isArray(list)) {
        return [];
    }
    return list.map((item) => ({
        name: item && (item.name || item.label || item.displayName),
        value: item && Object.prototype.hasOwnProperty.call(item, 'value') ? item.value : item
    })).filter((item) => item.name !== undefined || item.value !== undefined);
}

function getComponents(result) {
    if (!result || !result.success) {
        return [];
    }
    const data = result.data || result;
    if (Array.isArray(data.components)) {
        return data.components;
    }
    if (Array.isArray(data)) {
        return data;
    }
    return [];
}

function getNodeList(result) {
    if (!result || !result.success) {
        return [];
    }
    const data = result.data || result;
    if (Array.isArray(data.nodes)) {
        return data.nodes;
    }
    if (Array.isArray(data)) {
        return data;
    }
    if (Array.isArray(data.list)) {
        return data.list;
    }
    return [];
}

function isSceneRootNode(node) {
    if (!node) {
        return true;
    }
    const type = String(node.type || '');
    const path = String(node.path || '');
    const name = String(node.name || '');
    return type === 'cc.Scene' || path === 'scene' || name === 'scene';
}

function scanNodeId(node) {
    if (!node || isSceneRootNode(node)) {
        return null;
    }
    return node.uuid || node.path || node.name || node.node || null;
}

function inferPropertyType(value) {
    if (typeof value === 'boolean') {
        return 'boolean';
    }
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'integer' : 'float';
    }
    if (typeof value === 'string') {
        return 'string';
    }
    if (isObject(value) && ['x', 'y'].every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
        return Object.prototype.hasOwnProperty.call(value, 'z') ? 'vec3' : 'vec2';
    }
    if (isObject(value) && Object.prototype.hasOwnProperty.call(value, 'uuid')) {
        return 'asset';
    }
    return undefined;
}

function normalizeDimension(args) {
    return String((args && args.dimension) || '3d').toLowerCase() === '2d' ? '2d' : '3d';
}

function rigidbodyTypeFor(args) {
    return normalizeDimension(args) === '2d' ? RIGIDBODY_2D : RIGIDBODY_3D;
}

function colliderTypeFor(args) {
    const dimension = normalizeDimension(args);
    const requested = String((args && (args.colliderType || args.type)) || 'box').toLowerCase();
    if (COLLIDER_TYPES[requested]) {
        return COLLIDER_TYPES[requested];
    }
    if (dimension === '2d') {
        return COLLIDER_TYPES.box2d;
    }
    return COLLIDER_TYPES.box;
}

function materialContent(args) {
    const friction = Number(args.friction !== undefined ? args.friction : 0.6);
    const restitution = Number(args.restitution !== undefined ? args.restitution : 0);
    const rollingFriction = Number(args.rollingFriction !== undefined ? args.rollingFriction : 0);
    const spinningFriction = Number(args.spinningFriction !== undefined ? args.spinningFriction : 0);
    return JSON.stringify({
        __type__: 'cc.PhysicsMaterial',
        _name: args.name || 'PhysicsMaterial',
        friction,
        restitution,
        rollingFriction,
        spinningFriction
    }, null, 2);
}

function metaContent() {
    return JSON.stringify({
        ver: '1.0.0',
        importer: 'physics-material'
    }, null, 2);
}

function uniqueByValue(items) {
    const map = new Map();
    for (const item of items || []) {
        if (!item) {
            continue;
        }
        const key = `${item.name || ''}:${item.value}`;
        if (!map.has(key)) {
            map.set(key, item);
        }
    }
    return Array.from(map.values());
}

function hasProperty(component, property) {
    return !!(component && component.properties && component.properties[property]);
}

function resolveEnumValue(value, groups) {
    if (typeof value === 'number') {
        return { success: true, value };
    }
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
        return { success: true, value: Number(value) };
    }
    const normalized = String(value || '').toLowerCase();
    const match = (groups || []).find((item) => String(item.name || '').toLowerCase() === normalized);
    if (match) {
        return { success: true, value: match.value };
    }
    return fail(`未找到碰撞分组：${value}`);
}

function collectMatchingKeys(data, patterns, prefix, output) {
    if (!data || typeof data !== 'object') {
        return;
    }
    for (const [key, value] of Object.entries(data)) {
        const nextPath = prefix ? `${prefix}.${key}` : key;
        if (patterns.some((pattern) => pattern.test(key) || pattern.test(nextPath))) {
            output.push({
                path: nextPath,
                value: typeof value === 'object' ? '[object]' : value
            });
        }
        if (value && typeof value === 'object') {
            collectMatchingKeys(value, patterns, nextPath, output);
        }
    }
}

class PhysicsHandler {
    constructor() {
        this.component = new ComponentHandler();
        this.node = new NodeHandler();
    }

    getToolDefinition() {
        return {
            name: 'physics',
            description: [
                'Cocos 物理配置工具，用于检查和配置刚体、碰撞体、触发区域和投射物碰撞。',
                '该工具只处理物理组件配置，不生成战斗、AI、对象池或关卡脚本逻辑。',
                '使用 debug_draw_* 可视化调试前，先通过 cocos_runtime.open_injected_preview 打开系统外部浏览器自动注入预览页；不要使用 Codex 内部浏览器查看调试绘制。',
                '射线调试优先使用 debug_draw_ray，并传 originNode + targetNode；移动节点传 live:true，工具会每帧重新采样射线、命中点和命中节点。',
                'debug_draw_ray 默认执行 raycast 命中检测，返回 hitInfo.result.node/collider/point/distance，并在画面中显示“命中：节点名”。建议同时调用 debug_draw_all_colliders 显示碰撞体线框。',
                '业务射线接入：游戏代码通过 window.__cocosMcpRuntimeBridge.registerDebugRay/reportDebugRay 注册和上报，MCP 用 watch_runtime_ray 监听并复用现有调试绘制出口。',
                'Runtime area debug is independent from ray debug: use debug_draw_area for temporary ranges and register_runtime_area/report_runtime_area/watch_runtime_area for business attack ranges, vision ranges, and trigger zones.',
                'Actions: info, list, add_rigidbody, add_collider, set_rigidbody, set_collider, setup_trigger_zone, setup_projectile_collision, validate_physics, list_collision_groups, set_collision_group, set_collision_mask, inspect_physics_settings, set_physics_debug, validate_physics_scene, create_physics_material, assign_physics_material, inspect_physics_material, debug_draw_ray, debug_draw_area, debug_draw_collider, debug_draw_all_colliders, debug_add_collider, debug_clear_drawings, debug_set_visibility, register_runtime_ray, report_runtime_ray, list_runtime_rays, watch_runtime_ray, unwatch_runtime_ray, clear_runtime_rays, register_runtime_area, report_runtime_area, list_runtime_areas, watch_runtime_area, unwatch_runtime_area, clear_runtime_areas.'
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ACTIONS,
                        description: '物理操作'
                    },
                    node: {
                        type: 'string',
                        description: '节点名称、路径或 UUID'
                    },
                    id: {
                        type: 'string',
                        description: 'register_runtime_ray/watch_runtime_ray/unwatch_runtime_ray 的业务射线唯一 ID'
                    },
                    rayId: {
                        type: 'string',
                        description: '业务射线 ID，id 的别名'
                    },
                    description: {
                        type: 'string',
                        description: 'register_runtime_ray 业务射线说明'
                    },
                    mode: {
                        type: 'string',
                        enum: ['event', 'persistent'],
                        description: 'register_runtime_ray 业务射线模式：event 一次性事件射线，persistent 常驻追踪射线'
                    },
                    tags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'register_runtime_ray 业务射线标签，方便 Codex 搜索，例如 player/weapon/vision'
                    },
                    defaultDuration: {
                        type: 'number',
                        description: 'register_runtime_ray 事件型射线每次上报后的默认显示时长，毫秒'
                    },
                    query: {
                        type: 'string',
                        description: 'list_runtime_rays/watch_runtime_ray 可用的搜索关键词或业务射线 ID'
                    },
                    hit: {
                        type: 'object',
                        description: 'report_runtime_ray 上报的命中信息，可包含 point/node/nodeUuid/nodePath/collider/colliderUuid/distance'
                    },
                    areaId: {
                        type: 'string',
                        description: '业务检测区域 ID，id 的别名'
                    },
                    shape: {
                        type: 'string',
                        enum: ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'sector'],
                        description: 'debug_draw_area/register_runtime_area/report_runtime_area 的区域形状'
                    },
                    areaType: {
                        type: 'string',
                        enum: ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'sector'],
                        description: '区域形状别名，等同 shape'
                    },
                    angle: {
                        type: 'number',
                        description: 'sector 扇形区域角度，单位度'
                    },
                    angleDegrees: {
                        type: 'number',
                        description: 'sector 扇形区域角度别名，单位度'
                    },
                    forward: {
                        type: 'object',
                        description: 'sector 扇形区域朝向 {x,y,z}'
                    },
                    centerNode: {
                        type: 'string',
                        description: 'debug_draw_area 区域跟随节点'
                    },
                    followNode: {
                        type: 'string',
                        description: 'debug_draw_area 区域跟随节点别名'
                    },
                    rootNode: {
                        type: 'string',
                        description: 'list/validate_physics 的扫描根节点，未提供时扫描当前场景节点列表'
                    },
                    dimension: {
                        type: 'string',
                        enum: ['3d', '2d'],
                        description: '物理维度，默认 3d'
                    },
                    colliderType: {
                        type: 'string',
                        enum: ['box', 'sphere', 'capsule', 'mesh', 'box2d', 'circle2d', 'polygon2d'],
                        description: '碰撞体类型，默认 box'
                    },
                    rigidbodyType: {
                        oneOf: [{ type: 'string' }, { type: 'number' }],
                        description: '刚体类型，可传 dynamic/static/kinematic 或 Cocos 枚举数值'
                    },
                    mass: { type: 'number', description: '刚体质量' },
                    useGravity: { type: 'boolean', description: '是否使用重力' },
                    linearDamping: { type: 'number', description: '线性阻尼' },
                    angularDamping: { type: 'number', description: '角阻尼' },
                    allowSleep: { type: 'boolean', description: '是否允许休眠' },
                    isTrigger: { type: 'boolean', description: '碰撞体是否作为触发器' },
                    center: { type: 'object', description: '碰撞体中心 {x,y,z}' },
                    size: { type: 'object', description: '盒形碰撞体尺寸 {x,y,z}' },
                    radius: { type: 'number', description: '球形/胶囊/圆形碰撞体半径' },
                    height: { type: 'number', description: '胶囊碰撞体高度；会优先写入 cylinderHeight' },
                    direction: { type: 'number', description: '胶囊碰撞体方向枚举' },
                    group: {
                        oneOf: [{ type: 'string' }, { type: 'number' }],
                        description: '碰撞分组'
                    },
                    mask: {
                        oneOf: [{ type: 'string' }, { type: 'number' }],
                        description: '碰撞掩码'
                    },
                    ensureRigidbody: {
                        type: 'boolean',
                        description: '预设操作是否同时确保刚体存在，默认 true'
                    },
                    maxNodes: {
                        type: 'number',
                        description: 'list/validate_physics 最多扫描节点数量，默认 200'
                    },
                    origin: {
                        type: 'object',
                        description: 'debug_draw_ray 射线起点 {x,y,z}'
                    },
                    originNode: {
                        type: 'string',
                        description: 'debug_draw_ray 射线起点节点名称/路径/UUID；优先使用该节点碰撞体中心作为起点'
                    },
                    fromNode: {
                        type: 'string',
                        description: 'debug_draw_ray 的 originNode 别名'
                    },
                    target: {
                        type: 'object',
                        description: 'debug_draw_ray 射线目标点 {x,y,z}；会根据 origin 自动计算方向和距离'
                    },
                    targetNode: {
                        type: 'string',
                        description: 'debug_draw_ray 射线目标节点名称/路径/UUID；优先使用该节点碰撞体中心作为目标点'
                    },
                    toNode: {
                        type: 'string',
                        description: 'debug_draw_ray 的 targetNode 别名'
                    },
                    originOffset: {
                        type: 'object',
                        description: 'debug_draw_ray 起点节点偏移 {x,y,z}，用于从枪口、眼睛、技能挂点等位置发射'
                    },
                    targetOffset: {
                        type: 'object',
                        description: 'debug_draw_ray 目标节点偏移 {x,y,z}'
                    },
                    direction: {
                        type: 'object',
                        description: 'debug_draw_ray 射线方向 {x,y,z}'
                    },
                    maxDistance: {
                        type: 'number',
                        description: 'debug_draw_ray 射线长度'
                    },
                    raycast: {
                        type: 'boolean',
                        description: 'debug_draw_ray 是否执行物理射线命中检测，默认 true；命中结果在 hitInfo.result 中返回'
                    },
                    live: {
                        type: 'boolean',
                        description: '是否每帧实时重新采样。debug_draw_ray 默认 false；debug_draw_collider/debug_draw_all_colliders 默认 true，移动节点调试建议保持 true'
                    },
                    queryTrigger: {
                        type: 'boolean',
                        description: 'debug_draw_ray 是否检测 trigger 碰撞体，默认 true'
                    },
                    color: {
                        oneOf: [{ type: 'string' }, { type: 'object' }],
                        description: '调试绘制颜色，例如 #ff3355 或 {r,g,b,a}'
                    },
                    hitColor: {
                        oneOf: [{ type: 'string' }, { type: 'object' }],
                        description: 'debug_draw_ray 命中点标记颜色，默认黄色'
                    },
                    hitLabel: {
                        type: 'string',
                        description: 'debug_draw_ray 命中点标签；不传时自动显示“命中：节点名”，支持 {node}/{collider}/{distance} 占位符'
                    },
                    duration: {
                        type: 'number',
                        description: '调试绘制持续时间，毫秒；0 表示持续到手动清除'
                    },
                    thickness: {
                        type: 'number',
                        description: '调试绘制线宽'
                    },
                    showLabel: {
                        type: 'boolean',
                        description: '是否显示调试标签，默认 true'
                    },
                    enabled: {
                        type: 'boolean',
                        description: 'debug_set_visibility 是否启用全部调试绘制显示'
                    },
                    showRays: {
                        type: 'boolean',
                        description: 'debug_set_visibility 是否显示射线'
                    },
                    showAreas: {
                        type: 'boolean',
                        description: 'debug_set_visibility 是否显示检测区域'
                    },
                    showColliders: {
                        type: 'boolean',
                        description: 'debug_set_visibility 是否显示碰撞体'
                    },
                    hitCollidersOnly: {
                        type: 'boolean',
                        description: 'debug_set_visibility 是否只显示射线当前命中的碰撞体；开启后会自动显示射线和碰撞体'
                    },
                    areaHitCollidersOnly: {
                        type: 'boolean',
                        description: 'debug_set_visibility 是否只显示检测区域当前命中的碰撞体；开启后会自动显示区域和碰撞体'
                    },
                    panelVisible: {
                        type: 'boolean',
                        description: 'debug_set_visibility 是否显示可拖动调试面板'
                    },
                    depthTest: {
                        type: 'boolean',
                        description: 'debug_set_visibility 是否开启深度遮挡显示；true 会被模型遮挡，false 始终置顶显示'
                    },
                    alwaysOnTop: {
                        type: 'boolean',
                        description: 'debug_set_visibility 是否始终置顶显示；true 等价于 depthTest:false'
                    },
                    sceneRender: {
                        type: 'boolean',
                        description: 'debug_set_visibility 是否在深度遮挡模式下使用 Cocos 场景内细杆 Mesh 渲染线框；默认 true'
                    },
                    includeInactive: {
                        type: 'boolean',
                        description: 'debug_draw_all_colliders 是否包含 inactive 节点'
                    },
                    maxCount: {
                        type: 'number',
                        description: 'debug_draw_all_colliders 最大绘制碰撞体数量，默认 200'
                    },
                    clientId: {
                        type: 'string',
                        description: 'Runtime client id. Debug drawing will be sent to this connected preview page.'
                    },
                    targetClientId: {
                        type: 'string',
                        description: 'Alias of clientId for selecting the runtime target page.'
                    },
                    componentScope: {
                        type: 'string',
                        enum: ['all', 'rigidbody', 'collider'],
                        description: 'set_collision_group/set_collision_mask/assign_physics_material 的组件范围，默认 all'
                    },
                    materialUrl: {
                        type: 'string',
                        description: '物理材质资源路径，例如 db://assets/physics/Bouncy.physics-material'
                    },
                    folder: {
                        type: 'string',
                        description: '创建物理材质的目标文件夹，默认 db://assets/physics'
                    },
                    name: {
                        type: 'string',
                        description: '物理材质名称'
                    },
                    friction: {
                        type: 'number',
                        description: '物理材质摩擦力'
                    },
                    restitution: {
                        type: 'number',
                        description: '物理材质弹力/反弹系数'
                    },
                    rollingFriction: {
                        type: 'number',
                        description: '滚动摩擦'
                    },
                    spinningFriction: {
                        type: 'number',
                        description: '旋转摩擦'
                    },
                    enabled: {
                        type: 'boolean',
                        description: 'set_physics_debug 是否启用调试显示'
                    },
                    overwrite: {
                        type: 'boolean',
                        description: 'create_physics_material 是否覆盖已有资源'
                    }
                },
                required: ['action']
            }
        };
    }

    async execute(args = {}) {
        switch (args.action) {
            case 'info':
                return await this.info(args);
            case 'list':
                return await this.list(args);
            case 'add_rigidbody':
                return await this.addRigidbody(args);
            case 'add_collider':
                return await this.addCollider(args);
            case 'set_rigidbody':
                return await this.setRigidbody(args);
            case 'set_collider':
                return await this.setCollider(args);
            case 'setup_trigger_zone':
                return await this.setupTriggerZone(args);
            case 'setup_projectile_collision':
                return await this.setupProjectileCollision(args);
            case 'validate_physics':
                return await this.validatePhysics(args);
            case 'list_collision_groups':
                return await this.listCollisionGroups(args);
            case 'set_collision_group':
                return await this.setCollisionGroup(args);
            case 'set_collision_mask':
                return await this.setCollisionMask(args);
            case 'inspect_physics_settings':
                return await this.inspectPhysicsSettings(args);
            case 'set_physics_debug':
                return await this.setPhysicsDebug(args);
            case 'validate_physics_scene':
                return await this.validatePhysicsScene(args);
            case 'create_physics_material':
                return await this.createPhysicsMaterial(args);
            case 'assign_physics_material':
                return await this.assignPhysicsMaterial(args);
            case 'inspect_physics_material':
                return await this.inspectPhysicsMaterial(args);
            case 'debug_draw_ray':
            case 'debug_draw_area':
            case 'debug_draw_collider':
            case 'debug_draw_all_colliders':
            case 'debug_add_collider':
            case 'debug_clear_drawings':
            case 'debug_set_visibility':
            case 'register_runtime_ray':
            case 'report_runtime_ray':
            case 'list_runtime_rays':
            case 'watch_runtime_ray':
            case 'unwatch_runtime_ray':
            case 'clear_runtime_rays':
            case 'register_runtime_area':
            case 'report_runtime_area':
            case 'list_runtime_areas':
            case 'watch_runtime_area':
            case 'unwatch_runtime_area':
            case 'clear_runtime_areas':
                return await this.executeRuntimeDebug(args.action, args);
            default:
                return fail(`未知物理操作：${args.action || '(empty)'}`);
        }
    }

    requireNode(args) {
        if (!args.node) {
            return fail('node 是必填参数，请提供节点名称、路径或 UUID。');
        }
        return null;
    }

    async addComponent(node, componentType) {
        return await this.component.execute({
            action: 'add',
            node,
            componentType
        });
    }

    async setProperty(node, componentType, property, value, propertyType) {
        return await this.component.execute({
            action: 'set_property',
            node,
            componentType,
            componentName: componentType,
            property,
            propertyType: propertyType || inferPropertyType(value),
            value
        });
    }

    async setProperties(node, componentType, properties) {
        const applied = [];
        const failed = [];
        for (const [property, value] of Object.entries(properties)) {
            if (value === undefined) {
                continue;
            }
            const result = await this.setProperty(node, componentType, property, value);
            if (result && result.success) {
                applied.push(property);
            }
            else {
                failed.push({ property, error: result && result.error ? result.error : '设置失败' });
            }
        }
        return { applied, failed };
    }

    async getPhysicsInfo(node) {
        const result = await this.component.execute({ action: 'list', node });
        if (!result || !result.success) {
            return result;
        }
        const components = getComponents(result).map(simplifyComponent);
        const physicsComponents = components.filter((item) => item.category !== 'other');
        return ok({
            node,
            nodeUuid: result.data && result.data.nodeUuid,
            rigidbodies: physicsComponents.filter((item) => item.category === 'rigidbody'),
            colliders: physicsComponents.filter((item) => item.category === 'collider'),
            physicsComponents
        });
    }

    async hasComponent(node, componentType) {
        const info = await this.getPhysicsInfo(node);
        if (!info || !info.success) {
            return { exists: false, info };
        }
        const exists = (info.data.physicsComponents || []).some((component) => component.type === componentType);
        return { exists, info };
    }

    async info(args) {
        const missing = this.requireNode(args);
        if (missing) {
            return missing;
        }
        return await this.getPhysicsInfo(args.node);
    }

    async list(args) {
        const nodesResult = await this.node.execute(args.rootNode
            ? { action: 'tree', node: args.rootNode, maxDepth: 20 }
            : { action: 'list' });
        if (!nodesResult || !nodesResult.success) {
            return nodesResult;
        }
        const nodes = getNodeList(nodesResult);
        const maxNodes = Math.max(1, Number(args.maxNodes) || 200);
        const scanCandidates = nodes.filter((node) => !!scanNodeId(node));
        const scanned = scanCandidates.slice(0, maxNodes);
        const items = [];
        const errors = [];
        for (const node of scanned) {
            const id = scanNodeId(node);
            const displayName = node.path || node.name || id;
            const info = await this.getPhysicsInfo(id);
            if (info && info.success && info.data.physicsComponents.length > 0) {
                items.push(Object.assign({}, info.data, {
                    node: displayName,
                    uuid: node.uuid || info.data.nodeUuid
                }));
            }
            else if (info && !info.success) {
                errors.push({ node: displayName, error: info.error });
            }
        }
        return ok({
            scanned: scanned.length,
            totalNodes: nodes.length,
            skipped: nodes.length - scanCandidates.length,
            physicsNodeCount: items.length,
            nodes: items,
            errors
        });
    }

    async addRigidbody(args) {
        const missing = this.requireNode(args);
        if (missing) {
            return missing;
        }
        const componentType = rigidbodyTypeFor(args);
        const existing = await this.hasComponent(args.node, componentType);
        let addResult = {
            success: true,
            skipped: true,
            message: '节点已存在对应刚体组件，已跳过重复添加。'
        };
        if (!existing.exists) {
            addResult = await this.addComponent(args.node, componentType);
            if (!addResult || !addResult.success) {
                return addResult;
            }
        }
        const properties = this.pickRigidbodyProperties(args);
        const propertyResult = await this.setProperties(args.node, componentType, properties);
        return ok({
            node: args.node,
            componentType,
            addResult,
            properties: propertyResult
        }, '刚体组件已添加。');
    }

    async addCollider(args) {
        const missing = this.requireNode(args);
        if (missing) {
            return missing;
        }
        const componentType = colliderTypeFor(args);
        const existing = await this.hasComponent(args.node, componentType);
        let addResult = {
            success: true,
            skipped: true,
            message: '节点已存在对应碰撞体组件，已跳过重复添加。'
        };
        if (!existing.exists) {
            addResult = await this.addComponent(args.node, componentType);
            if (!addResult || !addResult.success) {
                return addResult;
            }
        }
        const properties = this.pickColliderProperties(args);
        const propertyResult = await this.setProperties(args.node, componentType, properties);
        return ok({
            node: args.node,
            componentType,
            addResult,
            properties: propertyResult
        }, '碰撞体组件已添加。');
    }

    async setRigidbody(args) {
        const missing = this.requireNode(args);
        if (missing) {
            return missing;
        }
        const componentType = rigidbodyTypeFor(args);
        const propertyResult = await this.setProperties(args.node, componentType, this.pickRigidbodyProperties(args));
        return ok({
            node: args.node,
            componentType,
            properties: propertyResult
        }, '刚体属性已更新。');
    }

    async setCollider(args) {
        const missing = this.requireNode(args);
        if (missing) {
            return missing;
        }
        const componentType = colliderTypeFor(args);
        const propertyResult = await this.setProperties(args.node, componentType, this.pickColliderProperties(args));
        return ok({
            node: args.node,
            componentType,
            properties: propertyResult
        }, '碰撞体属性已更新。');
    }

    async setupTriggerZone(args) {
        const missing = this.requireNode(args);
        if (missing) {
            return missing;
        }
        const steps = [];
        if (args.ensureRigidbody !== false) {
            steps.push({ step: 'add_rigidbody', result: await this.addRigidbody(Object.assign({}, args, { rigidbodyType: args.rigidbodyType || 'static' })) });
        }
        steps.push({ step: 'add_collider', result: await this.addCollider(Object.assign({}, args, { isTrigger: true })) });
        return ok({
            node: args.node,
            steps
        }, '触发区域物理组件已配置。');
    }

    async setupProjectileCollision(args) {
        const missing = this.requireNode(args);
        if (missing) {
            return missing;
        }
        const base = Object.assign({
            rigidbodyType: 'dynamic',
            useGravity: false,
            isTrigger: args.isTrigger !== false
        }, args);
        const steps = [];
        if (args.ensureRigidbody !== false) {
            steps.push({ step: 'add_rigidbody', result: await this.addRigidbody(base) });
        }
        steps.push({ step: 'add_collider', result: await this.addCollider(base) });
        return ok({
            node: args.node,
            steps
        }, '投射物碰撞物理组件已配置。');
    }

    async validatePhysics(args) {
        const list = await this.list(args);
        if (!list || !list.success) {
            return list;
        }
        const issues = [];
        for (const item of list.data.nodes || []) {
            const rigidbodies = item.rigidbodies || [];
            const colliders = item.colliders || [];
            if (rigidbodies.length > 0 && colliders.length === 0) {
                issues.push({
                    severity: 'warning',
                    node: item.node,
                    message: '节点有刚体但没有碰撞体，通常无法产生期望的碰撞。'
                });
            }
            if (colliders.length > 0 && rigidbodies.length === 0) {
                issues.push({
                    severity: 'info',
                    node: item.node,
                    message: '节点有碰撞体但本节点没有刚体；如果碰撞另一方也没有刚体，可能不会触发物理事件。'
                });
            }
            for (const collider of colliders) {
                const props = collider.properties || {};
                if (props.isTrigger === true && rigidbodies.length === 0) {
                    issues.push({
                        severity: 'warning',
                        node: item.node,
                        component: collider.type,
                        message: '触发器碰撞体所在节点没有刚体，触发事件可能依赖碰撞另一方刚体。'
                    });
                }
                if (/MeshCollider/i.test(collider.type) && rigidbodies.some((body) => String((body.properties || {}).type) !== String(RIGIDBODY_TYPE_VALUES.static))) {
                    issues.push({
                        severity: 'warning',
                        node: item.node,
                        component: collider.type,
                        message: '动态刚体搭配 MeshCollider 可能成本较高或行为不符合预期，优先考虑基础碰撞体。'
                    });
                }
                if (props.radius === 0 || props.height === 0 || props.cylinderHeight === 0) {
                    issues.push({
                        severity: 'error',
                        node: item.node,
                        component: collider.type,
                        message: '碰撞体半径或高度为 0。'
                    });
                }
                if (isObject(props.size) && (Number(props.size.x) === 0 || Number(props.size.y) === 0 || Number(props.size.z) === 0)) {
                    issues.push({
                        severity: 'error',
                        node: item.node,
                        component: collider.type,
                        message: '盒形碰撞体尺寸包含 0。'
                    });
                }
            }
        }
        return ok({
            scanned: list.data.scanned,
            physicsNodeCount: list.data.physicsNodeCount,
            issueCount: issues.length,
            issues
        });
    }

    async getRawPhysicsComponents(node, scope) {
        const result = await this.component.execute({ action: 'list', node });
        if (!result || !result.success) {
            return { success: false, error: result && result.error ? result.error : '读取节点组件失败' };
        }
        const requestedScope = String(scope || 'all').toLowerCase();
        const components = getComponents(result).filter((component) => {
            const type = componentType(component);
            if (requestedScope === 'rigidbody') {
                return isRigidbody(type);
            }
            if (requestedScope === 'collider') {
                return isCollider(type);
            }
            return isRigidbody(type) || isCollider(type);
        });
        return { success: true, data: { components } };
    }

    async listCollisionGroups(args) {
        const groups = [];
        const inspectedNodes = [];
        const errors = [];
        let source = 'fallback';
        let nodeIds = [];
        if (args.node) {
            nodeIds = [args.node];
        }
        else {
            const list = await this.list(args);
            if (list && list.success) {
                nodeIds = (list.data.nodes || []).map((item) => item.uuid || item.node).filter(Boolean);
            }
        }
        const maxNodes = Math.max(1, Number(args.maxNodes) || 50);
        for (const nodeId of nodeIds.slice(0, maxNodes)) {
            const raw = await this.getRawPhysicsComponents(nodeId, 'all');
            if (!raw.success) {
                errors.push({ node: nodeId, error: raw.error });
                continue;
            }
            inspectedNodes.push(nodeId);
            for (const component of raw.data.components || []) {
                const meta = propMeta(component, 'group');
                const list = normalizeEnumList(meta);
                if (list.length > 0) {
                    source = 'component metadata';
                    groups.push(...list);
                }
                const current = propValue(component, 'group');
                if (current !== undefined) {
                    groups.push({
                        name: current === 1 ? 'DEFAULT' : `GROUP_${current}`,
                        value: current
                    });
                }
            }
        }
        if (groups.length === 0) {
            groups.push({ name: 'DEFAULT', value: 1 });
        }
        return ok({
            groups: uniqueByValue(groups),
            source,
            inspectedNodes,
            errors,
            note: source === 'fallback'
                ? '当前场景没有可读取的碰撞分组元数据，已返回 Cocos 默认分组。'
                : '碰撞分组来自当前物理组件的属性元数据。'
        });
    }

    async setCollisionGroup(args) {
        const missing = this.requireNode(args);
        if (missing) {
            return missing;
        }
        if (args.group === undefined) {
            return fail('group 是必填参数。');
        }
        const groupInfo = await this.listCollisionGroups(Object.assign({}, args, { node: args.node }));
        const resolved = resolveEnumValue(args.group, groupInfo && groupInfo.success ? groupInfo.data.groups : []);
        if (!resolved.success) {
            return resolved;
        }
        const raw = await this.getRawPhysicsComponents(args.node, args.componentScope || 'all');
        if (!raw.success) {
            return raw;
        }
        const targets = (raw.data.components || []).filter((component) => hasProperty(component, 'group'));
        if (targets.length === 0) {
            return fail('当前目标物理组件没有可写入的 group 属性。3D 碰撞分组通常写在 cc.RigidBody 上。', {
                node: args.node,
                componentScope: args.componentScope || 'all',
                components: (raw.data.components || []).map((component) => componentType(component))
            });
        }
        const results = [];
        for (const component of targets) {
            const type = componentType(component);
            results.push({
                componentType: type,
                result: await this.setProperty(args.node, type, 'group', resolved.value, 'integer')
            });
        }
        return ok({
            node: args.node,
            group: resolved.value,
            updated: results.filter((item) => item.result && item.result.success).length,
            results
        }, '碰撞分组已更新。');
    }

    async setCollisionMask(args) {
        const missing = this.requireNode(args);
        if (missing) {
            return missing;
        }
        if (args.mask === undefined) {
            return fail('mask 是必填参数。');
        }
        const raw = await this.getRawPhysicsComponents(args.node, args.componentScope || 'all');
        if (!raw.success) {
            return raw;
        }
        const targets = (raw.data.components || []).filter((component) => hasProperty(component, 'mask'));
        if (targets.length === 0) {
            return fail('当前目标物理组件没有可写入的 mask 属性。Cocos Creator 3D 物理常用 group 分组，mask 不一定暴露在组件属性上。', {
                node: args.node,
                componentScope: args.componentScope || 'all',
                components: (raw.data.components || []).map((component) => componentType(component))
            });
        }
        const maskValue = typeof args.mask === 'number' ? args.mask : Number(args.mask);
        if (Number.isNaN(maskValue)) {
            return fail(`mask 必须是数字或数字字符串：${args.mask}`);
        }
        const results = [];
        for (const component of targets) {
            const type = componentType(component);
            results.push({
                componentType: type,
                result: await this.setProperty(args.node, type, 'mask', maskValue, 'integer')
            });
        }
        return ok({
            node: args.node,
            mask: maskValue,
            updated: results.filter((item) => item.result && item.result.success).length,
            results
        }, '碰撞掩码已更新。');
    }

    async inspectPhysicsSettings() {
        const root = projectRoot();
        const files = [
            'settings/v2/packages/project.json',
            'settings/v2/packages/engine.json',
            'profiles/v2/packages/project.json',
            'profiles/v2/packages/engine.json'
        ];
        const patterns = [/physics/i, /collision/i, /gravity/i, /debug/i, /group/i, /mask/i];
        const checked = [];
        const matches = [];
        for (const relative of files) {
            const filePath = path.join(root, relative);
            const exists = fs.existsSync(filePath);
            checked.push({ relative, exists });
            const json = readJsonIfExists(filePath);
            if (json) {
                const output = [];
                collectMatchingKeys(json, patterns, '', output);
                if (output.length > 0) {
                    matches.push({ relative, keys: output.slice(0, 100) });
                }
            }
        }
        return ok({
            projectRoot: root,
            checked,
            matches,
            supportLevel: matches.length > 0 ? 'detected' : 'limited',
            message: matches.length > 0
                ? '已在项目设置文件中发现疑似物理配置字段。'
                : '未在常见项目设置文件中发现稳定的物理配置字段；当前工具主要通过节点组件读写物理配置。'
        });
    }

    async setPhysicsDebug(args) {
        return fail('当前版本尚未确认 Cocos Creator 3.8 稳定的物理调试显示写入接口，因此不会硬写项目配置。请先在编辑器项目设置中开启物理调试显示。', {
            requestedEnabled: args.enabled,
            settings: await this.inspectPhysicsSettings(args)
        });
    }

    async validatePhysicsScene(args) {
        const validation = await this.validatePhysics(args);
        if (!validation || !validation.success) {
            return validation;
        }
        const groups = await this.listCollisionGroups(args);
        const settings = await this.inspectPhysicsSettings(args);
        const issues = Array.isArray(validation.data.issues) ? validation.data.issues.slice() : [];
        const knownGroupValues = new Set(((groups.data && groups.data.groups) || []).map((item) => item.value));
        const list = await this.list(args);
        if (list && list.success) {
            for (const item of list.data.nodes || []) {
                for (const body of item.rigidbodies || []) {
                    const value = body.properties && body.properties.group;
                    if (value !== undefined && knownGroupValues.size > 0 && !knownGroupValues.has(value)) {
                        issues.push({
                            severity: 'warning',
                            node: item.node,
                            component: body.type,
                            message: `刚体使用了当前分组列表中未出现的 group：${value}`
                        });
                    }
                }
            }
        }
        return ok({
            physics: validation.data,
            collisionGroups: groups.success ? groups.data : null,
            settings: settings.success ? settings.data : null,
            issueCount: issues.length,
            issues
        });
    }

    async executeRuntimeDebug(action, args) {
        const manager = globalThis.__cocosMcpRuntimeBridgeManager;
        if (!manager || typeof manager.execute !== 'function') {
            return fail('运行态桥接管理器尚未初始化，请先启动 MCP 服务，并通过 cocos_runtime.open_injected_preview 打开外部浏览器自动注入预览页。');
        }
        const result = await manager.execute(action, args || {});
        if (result && result.success === false && /bridge|版本|过旧|0\.1\./i.test(String(result.error || ''))) {
            return result;
        }
        return result;
    }

    materialDbUrl(args) {
        let dbUrl;
        const explicitUrl = args.materialUrl || args.url;
        if (explicitUrl) {
            dbUrl = toDbUrl(explicitUrl, args.folder, '.physics-material');
        }
        else {
            let folder = args.folder || 'db://assets/physics';
            if (!String(folder).startsWith('db://')) {
                folder = `db://assets/${String(folder).replace(/^\/+/, '')}`;
            }
            let name = args.name || `PhysicsMaterial_${Date.now()}`;
            if (!/\.(physics-material|physic-material)$/i.test(name)) {
                name = `${name}.physics-material`;
            }
            dbUrl = `${String(folder).replace(/\/$/, '')}/${name}`;
        }
        if (!/\.(physics-material|physic-material)$/i.test(dbUrl)) {
            const baseName = args.name || path.basename(dbUrl).replace(/\.[^.]+$/, '') || `PhysicsMaterial_${Date.now()}`;
            dbUrl = `${dbUrl.replace(/\/$/, '')}/${baseName}.physics-material`;
        }
        return dbUrl;
    }

    async refreshAsset(dbUrl) {
        if (!globalThis.Editor || !Editor.Message || !Editor.Message.request) {
            return { success: false, skipped: true, reason: 'Editor.Message 不可用' };
        }
        const attempts = [
            ['asset-db', 'refresh-asset', dbUrl],
            ['asset-db', 'refresh', dbUrl],
            ['asset-db', 'refresh']
        ];
        for (const [channel, message, payload] of attempts) {
            try {
                const result = payload === undefined
                    ? await Editor.Message.request(channel, message)
                    : await Editor.Message.request(channel, message, payload);
                return { success: true, channel, message, result };
            }
            catch (_) {}
        }
        return { success: false, skipped: true, reason: 'asset-db 刷新接口不可用' };
    }

    async queryAssetUuid(dbUrl) {
        if (!globalThis.Editor || !Editor.Message || !Editor.Message.request) {
            return null;
        }
        const attempts = [
            ['asset-db', 'query-uuid', dbUrl],
            ['asset-db', 'query-asset-uuid', dbUrl],
            ['asset-db', 'query-url-to-uuid', dbUrl]
        ];
        for (const [channel, message, payload] of attempts) {
            try {
                const result = await Editor.Message.request(channel, message, payload);
                if (typeof result === 'string' && result) {
                    return result;
                }
                if (result && typeof result.uuid === 'string') {
                    return result.uuid;
                }
            }
            catch (_) {}
        }
        return null;
    }

    async createPhysicsMaterial(args) {
        const dbUrl = this.materialDbUrl(args);
        const filePath = dbUrlToFilePath(dbUrl);
        if (!filePath) {
            return fail(`只支持 db://assets 下的物理材质路径：${dbUrl}`);
        }
        if (fs.existsSync(filePath) && args.overwrite !== true) {
            return fail('物理材质资源已存在，如需覆盖请传 overwrite: true。', { dbUrl, filePath });
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, materialContent(Object.assign({}, args, { name: args.name || path.basename(filePath, path.extname(filePath)) })), 'utf8');
        const metaPath = `${filePath}.meta`;
        if (!fs.existsSync(metaPath) || args.overwrite === true) {
            fs.writeFileSync(metaPath, metaContent(), 'utf8');
        }
        const refresh = await this.refreshAsset(dbUrl);
        return ok({
            dbUrl,
            filePath,
            metaPath,
            properties: {
                friction: Number(args.friction !== undefined ? args.friction : 0.6),
                restitution: Number(args.restitution !== undefined ? args.restitution : 0),
                rollingFriction: Number(args.rollingFriction !== undefined ? args.rollingFriction : 0),
                spinningFriction: Number(args.spinningFriction !== undefined ? args.spinningFriction : 0)
            },
            refresh
        }, '物理材质资源已创建。');
    }

    async inspectPhysicsMaterial(args) {
        const dbUrl = this.materialDbUrl(args);
        const filePath = dbUrlToFilePath(dbUrl);
        if (!filePath || !fs.existsSync(filePath)) {
            return fail('未找到物理材质资源。', { dbUrl, filePath });
        }
        const json = readJsonIfExists(filePath);
        const meta = readJsonIfExists(`${filePath}.meta`);
        return ok({
            dbUrl,
            filePath,
            material: json,
            meta
        });
    }

    async assignPhysicsMaterial(args) {
        const missing = this.requireNode(args);
        if (missing) {
            return missing;
        }
        if (!args.materialUrl && !args.url) {
            return fail('materialUrl 是必填参数。');
        }
        const dbUrl = this.materialDbUrl(args);
        const raw = await this.getRawPhysicsComponents(args.node, args.componentScope || 'collider');
        if (!raw.success) {
            return raw;
        }
        const targets = (raw.data.components || []).filter((component) => isCollider(componentType(component)));
        if (targets.length === 0) {
            return fail('当前节点没有可绑定物理材质的碰撞体组件。', { node: args.node });
        }
        const uuid = await this.queryAssetUuid(dbUrl);
        const assetValue = uuid || dbUrl;
        const results = [];
        for (const component of targets) {
            const type = componentType(component);
            const property = hasProperty(component, 'sharedMaterial')
                ? 'sharedMaterial'
                : hasProperty(component, 'material')
                    ? 'material'
                    : hasProperty(component, 'physicsMaterial')
                        ? 'physicsMaterial'
                        : null;
            if (!property) {
                results.push({ componentType: type, success: false, error: '组件没有材质属性' });
                continue;
            }
            results.push({
                componentType: type,
                property,
                result: await this.setProperty(args.node, type, property, assetValue, 'asset')
            });
        }
        return ok({
            node: args.node,
            materialUrl: dbUrl,
            uuid,
            updated: results.filter((item) => item.result && item.result.success).length,
            results
        }, '物理材质已绑定到碰撞体。');
    }

    pickRigidbodyProperties(args) {
        const properties = {};
        const typeValue = args.rigidbodyType;
        if (typeof typeValue === 'number') {
            properties.type = typeValue;
        }
        else if (typeof typeValue === 'string' && RIGIDBODY_TYPE_VALUES[typeValue.toLowerCase()] !== undefined) {
            properties.type = RIGIDBODY_TYPE_VALUES[typeValue.toLowerCase()];
        }
        for (const key of ['mass', 'useGravity', 'linearDamping', 'angularDamping', 'allowSleep', 'group', 'mask']) {
            if (args[key] !== undefined) {
                properties[key] = args[key];
            }
        }
        return properties;
    }

    pickColliderProperties(args) {
        const properties = {};
        for (const key of ['isTrigger', 'center', 'size', 'radius', 'direction', 'group', 'mask']) {
            if (args[key] !== undefined) {
                properties[key] = args[key];
            }
        }
        if (args.height !== undefined) {
            properties.cylinderHeight = args.height;
        }
        return properties;
    }
}

exports.PhysicsHandler = PhysicsHandler;
