'use strict';

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
    'validate_physics'
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
        'mask'
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
                'Actions: info, list, add_rigidbody, add_collider, set_rigidbody, set_collider, setup_trigger_zone, setup_projectile_collision, validate_physics.'
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
