'use strict';

const detailedGuides = [
    ['animation', './animation-guide', 'animationGuide'],
    ['scene', './scene-guide', 'sceneGuide'],
    ['node', './node-guide', 'nodeGuide'],
    ['component', './component-guide', 'componentGuide'],
    ['prefab', './prefab-guide', 'prefabGuide'],
    ['asset', './asset-guide', 'assetGuide'],
    ['editor', './editor-guide', 'editorGuide'],
    ['view', './view-guide', 'viewGuide'],
    ['composite', './composite-guide', 'compositeGuide'],
    ['validate', './validate-guide', 'validateGuide'],
    ['template', './template-guide', 'templateGuide'],
    ['capture', './capture-guide', 'captureGuide'],
    ['builder', './builder-guide', 'builderGuide']
];

const handlerGuides = [
    ['label', '../../handlers/font-handler', 'FontHandler'],
    ['spine', '../../handlers/spine-handler', 'SpineHandler'],
    ['physics', '../../handlers/physics-handler', 'PhysicsHandler'],
    ['material', '../../handlers/material-handler', 'MaterialHandler'],
    ['vfx', '../../handlers/vfx-handler', 'VfxHandler'],
    ['animation_mask', '../../handlers/animation-mask-handler', 'AnimationMaskHandler'],
    ['animation_graph', '../../handlers/animation-graph-handler', 'AnimationGraphHandler'],
    ['runtime', '../../handlers/runtime-handler', 'RuntimeHandler']
];

function normalizeToolName(toolName) {
    return String(toolName || '').trim().replace(/^cocos_/, '');
}

function loadDetailedGuide(modulePath, exportName) {
    try {
        const guideModule = require(modulePath);
        return guideModule && guideModule[exportName] ? guideModule[exportName] : null;
    }
    catch (_) {
        return null;
    }
}

function pickActionEnum(definition) {
    return definition
        && definition.inputSchema
        && definition.inputSchema.properties
        && definition.inputSchema.properties.action
        && Array.isArray(definition.inputSchema.properties.action.enum)
        ? definition.inputSchema.properties.action.enum
        : [];
}

function buildParamGuide(definition) {
    const properties = definition
        && definition.inputSchema
        && definition.inputSchema.properties
        ? definition.inputSchema.properties
        : {};
    const params = {};
    for (const [key, value] of Object.entries(properties)) {
        if (key === 'action') {
            continue;
        }
        params[key] = {
            type: value && value.type || 'any',
            description: value && value.description || ''
        };
    }
    return params;
}

function buildGuideFromHandler(localName, modulePath, exportName) {
    try {
        const handlerModule = require(modulePath);
        const HandlerClass = handlerModule && handlerModule[exportName];
        if (!HandlerClass) {
            return null;
        }
        const definition = new HandlerClass().getToolDefinition();
        const actionNames = pickActionEnum(definition);
        const sharedParams = buildParamGuide(definition);
        const actions = {};
        for (const action of actionNames) {
            actions[action] = {
                desc: `${definition.description || localName}。操作：${action}`,
                params: sharedParams
            };
        }
        return {
            desc: definition.description || localName,
            actions
        };
    }
    catch (_) {
        return null;
    }
}

function createPreviewGuide() {
    return {
        desc: 'Cocos 浏览器预览辅助工具：启动、停止、查询预览服务状态。',
        actions: {
            start: {
                desc: '启动或复用 Cocos 浏览器预览服务。',
                params: {
                    platform: { type: 'string', description: '预览平台，通常为 browser。' },
                    port: { type: 'number', description: '预览服务端口，默认 7456。' }
                }
            },
            stop: {
                desc: '停止 Cocos 浏览器预览服务。',
                params: {
                    port: { type: 'number', description: '预览服务端口，默认 7456。' }
                }
            },
            status: {
                desc: '获取 Cocos 浏览器预览服务状态。',
                params: {
                    port: { type: 'number', description: '预览服务端口，默认 7456。' }
                }
            }
        }
    };
}

function createKnowledgeGuide() {
    return {
        desc: 'Cocos Creator 参考知识：组件属性、UI 规则、布局模式、动画配方、工具指南。',
        actions: {
            tool_guide: {
                desc: '查询 cocos_* 工具的可用操作和参数说明。',
                params: {
                    query: { type: 'string', description: '工具名或工具.操作名，例如 cocos_material 或 material.inspect_effect。' }
                }
            }
        }
    };
}

function buildGuides() {
    const guides = {};
    for (const [name, modulePath, exportName] of detailedGuides) {
        const guide = loadDetailedGuide(modulePath, exportName);
        if (guide) {
            guides[name] = guide;
        }
    }
    for (const [name, modulePath, exportName] of handlerGuides) {
        const guide = buildGuideFromHandler(name, modulePath, exportName);
        if (guide) {
            guides[name] = guide;
        }
    }
    guides.preview = createPreviewGuide();
    guides.knowledge = createKnowledgeGuide();
    return guides;
}

function getToolIndex() {
    const output = {};
    for (const [name, guide] of Object.entries(buildGuides())) {
        output[name] = {
            desc: guide.desc,
            actions: Object.keys(guide.actions || {})
        };
    }
    return output;
}

function getToolGuide(toolName) {
    const guide = buildGuides()[normalizeToolName(toolName)];
    if (!guide) {
        return null;
    }
    const actions = {};
    for (const [action, actionGuide] of Object.entries(guide.actions || {})) {
        actions[action] = actionGuide.desc || '';
    }
    return {
        desc: guide.desc,
        actions
    };
}

function getActionGuide(toolName, actionName) {
    const guide = buildGuides()[normalizeToolName(toolName)];
    if (!guide || !guide.actions) {
        return null;
    }
    return guide.actions[actionName] || null;
}

function getToolNames() {
    return Object.keys(buildGuides());
}

function getActionNames(toolName) {
    const guide = buildGuides()[normalizeToolName(toolName)];
    if (!guide || !guide.actions) {
        return null;
    }
    return Object.keys(guide.actions);
}

exports.getToolIndex = getToolIndex;
exports.getToolGuide = getToolGuide;
exports.getActionGuide = getActionGuide;
exports.getToolNames = getToolNames;
exports.getActionNames = getActionNames;
