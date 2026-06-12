'use strict';

const os = require('os');
const net = require('net');

const PATCH_FLAG = Symbol.for('cocos-mcp-server.extended-tools-registry.v1');
const DEFAULT_PREVIEW_PORT = 7456;

const EXTENDED_TOOL_NAMES = [
    'cocos_animation_mask',
    'cocos_animation_graph',
    'cocos_preview',
    'cocos_runtime',
    'cocos_physics'
];

function createFreshHandler(modulePath, exportName) {
    const handlerPath = require.resolve(modulePath);
    delete require.cache[handlerPath];
    const handlerModule = require(modulePath);
    const HandlerClass = handlerModule && handlerModule[exportName];
    if (!HandlerClass) {
        throw new Error(`扩展工具处理器不存在：${exportName}`);
    }
    return new HandlerClass();
}

function createAnimationMaskHandler() {
    return createFreshHandler('./handlers/animation-mask-handler', 'AnimationMaskHandler');
}

function createAnimationGraphHandler() {
    return createFreshHandler('./handlers/animation-graph-handler', 'AnimationGraphHandler');
}

function createRuntimeHandler() {
    return createFreshHandler('./handlers/runtime-handler', 'RuntimeHandler');
}

function getPreviewState() {
    if (!globalThis.__cocosMcpPreviewStatus) {
        globalThis.__cocosMcpPreviewStatus = {
            requested: false,
            running: false,
            platform: null,
            port: DEFAULT_PREVIEW_PORT,
            lastStartTime: null,
            lastStopTime: null,
            startedByMcp: false,
            lastResult: null,
            source: 'mcp-recorded'
        };
    }
    return globalThis.__cocosMcpPreviewStatus;
}

function getLocalIps() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries || []) {
            if (entry && entry.family === 'IPv4' && !entry.internal && entry.address) {
                ips.push(entry.address);
            }
        }
    }
    return Array.from(new Set(ips));
}

function buildPreviewUrls(port) {
    const normalizedPort = Number(port) || DEFAULT_PREVIEW_PORT;
    return [
        `http://127.0.0.1:${normalizedPort}/`,
        `http://localhost:${normalizedPort}/`,
        ...getLocalIps().map((ip) => `http://${ip}:${normalizedPort}/`)
    ];
}

function probePort(host, port, timeout = 600) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (open) => {
            if (done) {
                return;
            }
            done = true;
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(timeout);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(Number(port) || DEFAULT_PREVIEW_PORT, host);
    });
}

function getPreviewStatus(extra = {}) {
    const state = getPreviewState();
    const port = Number(extra.port || state.port) || DEFAULT_PREVIEW_PORT;
    return Object.assign({}, state, {
        port,
        urls: buildPreviewUrls(port)
    }, extra);
}

function markPreviewStarted(args, result, beforeReachable) {
    const state = getPreviewState();
    const port = Number(args && args.port) || state.port || DEFAULT_PREVIEW_PORT;
    state.requested = true;
    state.running = !!(result && result.success);
    state.platform = (args && args.platform) || 'browser';
    state.port = port;
    state.lastStartTime = new Date().toISOString();
    state.startedByMcp = true;
    state.lastResult = result || null;
    state.source = 'mcp-recorded';
    return getPreviewStatus({
        reachableBeforeStart: beforeReachable,
        possibleReusedExistingServer: beforeReachable === true
    });
}

function markPreviewStopped(args, result) {
    const state = getPreviewState();
    state.requested = false;
    state.running = false;
    state.platform = (args && args.platform) || state.platform;
    state.port = Number(args && args.port) || state.port || DEFAULT_PREVIEW_PORT;
    state.lastStopTime = new Date().toISOString();
    state.lastResult = result || null;
    state.source = 'mcp-recorded';
    return getPreviewStatus();
}

function createPreviewToolDefinition() {
    return {
        name: 'preview',
        description: 'Cocos 浏览器预览辅助工具 - 启动/停止预览，并返回预览状态、启动时间、预览地址和是否可能复用已有服务。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['start', 'stop', 'status'],
                    description: '预览操作：start 启动，stop 停止，status 获取状态'
                },
                platform: {
                    type: 'string',
                    description: '预览平台，通常为 browser'
                },
                port: {
                    type: 'number',
                    description: '预览服务端口，默认 7456'
                }
            },
            required: ['action']
        }
    };
}

function getExtendedToolDefinitions() {
    return [
        createAnimationMaskHandler().getToolDefinition(),
        createAnimationGraphHandler().getToolDefinition(),
        createPreviewToolDefinition(),
        createRuntimeHandler().getToolDefinition()
    ];
}

function upsertToolDefinitions(tools, definitions) {
    for (const definition of definitions) {
        const index = tools.findIndex((tool) => tool && tool.name === definition.name);
        if (index >= 0) {
            tools[index] = definition;
        }
        else {
            tools.push(definition);
        }
    }
    return tools;
}

function isToolName(toolName, localName) {
    return toolName === localName || toolName === `cocos_${localName}`;
}

async function executeHandler(createHandler, args) {
    try {
        return await createHandler().execute(args || {});
    }
    catch (error) {
        return {
            success: false,
            error: error && error.message ? error.message : String(error)
        };
    }
}

async function runPreviewAction(instance, originalExecute, args) {
    const port = Number(args && args.port) || DEFAULT_PREVIEW_PORT;
    const beforeReachable = await probePort('127.0.0.1', port);
    const runArgs = Object.assign({}, args || {}, {
        action: 'run',
        platform: (args && args.platform) || 'browser'
    });
    const result = await originalExecute.call(instance, 'editor', runArgs);
    const previewStatus = markPreviewStarted(runArgs, result, beforeReachable);
    if (result && typeof result === 'object') {
        return Object.assign({}, result, {
            message: result.message || '浏览器预览已启动。',
            data: Object.assign({}, result.data || {}, { previewStatus })
        });
    }
    return {
        success: true,
        message: '浏览器预览已启动。',
        data: { result, previewStatus }
    };
}

async function stopPreviewAction(instance, originalExecute, args) {
    const stopArgs = Object.assign({}, args || {}, { action: 'stop' });
    const result = await originalExecute.call(instance, 'editor', stopArgs);
    const previewStatus = markPreviewStopped(stopArgs, result);
    if (result && typeof result === 'object') {
        return Object.assign({}, result, {
            message: result.message || '浏览器预览已停止。',
            data: Object.assign({}, result.data || {}, { previewStatus })
        });
    }
    return {
        success: true,
        message: '浏览器预览已停止。',
        data: { result, previewStatus }
    };
}

async function executePreviewTool(instance, originalExecute, args) {
    const action = args && args.action;
    if (action === 'start') {
        return await runPreviewAction(instance, originalExecute, args || {});
    }
    if (action === 'stop') {
        return await stopPreviewAction(instance, originalExecute, args || {});
    }
    if (action === 'status') {
        return {
            success: true,
            message: '已获取浏览器预览状态。',
            data: getPreviewStatus({ port: args && args.port })
        };
    }
    return {
        success: false,
        error: `未知预览操作：${action || ''}`
    };
}

async function executeExtendedTool(instance, originalExecute, toolName, args) {
    const normalizedName = toolName === 'cocos_editor' ? 'editor' : toolName;
    const action = args && args.action;

    if (normalizedName === 'editor' && action === 'run') {
        return await runPreviewAction(instance, originalExecute, args || {});
    }
    if (normalizedName === 'editor' && action === 'stop') {
        return await stopPreviewAction(instance, originalExecute, args || {});
    }
    if (normalizedName === 'editor' && (action === 'preview_status' || action === 'get_preview_status')) {
        return {
            success: true,
            message: '已获取浏览器预览状态。',
            data: getPreviewStatus({ port: args && args.port })
        };
    }

    if (isToolName(toolName, 'animation_mask')) {
        return await executeHandler(createAnimationMaskHandler, args);
    }
    if (isToolName(toolName, 'animation_graph')) {
        return await executeHandler(createAnimationGraphHandler, args);
    }
    if (isToolName(toolName, 'preview')) {
        return await executePreviewTool(instance, originalExecute, args || {});
    }
    if (isToolName(toolName, 'runtime')) {
        return await executeHandler(createRuntimeHandler, args);
    }

    return null;
}

function install() {
    const cocosToolsModule = require('./cocos-tools');
    const CocosTools = cocosToolsModule && cocosToolsModule.CocosTools;
    if (!CocosTools || !CocosTools.prototype) {
        throw new Error('CocosTools export was not found');
    }
    if (CocosTools.prototype[PATCH_FLAG]) {
        return;
    }

    const originalGetTools = CocosTools.prototype.getTools;
    const originalExecute = CocosTools.prototype.execute;

    CocosTools.prototype.getTools = function extendedGetTools() {
        const tools = originalGetTools.call(this);
        return upsertToolDefinitions(tools, getExtendedToolDefinitions());
    };

    CocosTools.prototype.execute = async function extendedExecute(toolName, args) {
        const result = await executeExtendedTool(this, originalExecute, toolName, args);
        if (result) {
            return result;
        }
        return await originalExecute.call(this, toolName, args);
    };

    Object.defineProperty(CocosTools.prototype, PATCH_FLAG, {
        value: true,
        enumerable: false
    });
}

module.exports = {
    EXTENDED_TOOL_NAMES,
    executeExtendedTool,
    getExtendedToolDefinitions,
    install
};
