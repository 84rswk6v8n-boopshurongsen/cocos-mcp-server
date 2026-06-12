'use strict';

const os = require('os');
const net = require('net');

const PATCH_FLAG = Symbol.for('cocos-mcp-server.preview-status-patch.v1');
const DEFAULT_PREVIEW_PORT = 7456;

function getState() {
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

function buildUrls(port) {
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
    const state = getState();
    const port = Number(extra.port || state.port) || DEFAULT_PREVIEW_PORT;
    return Object.assign({}, state, {
        port,
        urls: buildUrls(port)
    }, extra);
}

function markStarted(args, result, beforeReachable) {
    const state = getState();
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

function markStopped(args, result) {
    const state = getState();
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
        description: 'Cocos 浏览器预览辅助 - 启动/停止预览，并返回预览状态、启动时间、预览地址和是否可能复用已有服务。',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['start', 'stop', 'status'],
                    description: 'Preview action to perform'
                },
                platform: {
                    type: 'string',
                    description: 'Preview platform, usually browser'
                },
                port: {
                    type: 'number',
                    description: 'Preview server port, defaults to 7456'
                }
            },
            required: ['action']
        }
    };
}

async function runPreviewAction(instance, originalExecute, args) {
    const port = Number(args && args.port) || DEFAULT_PREVIEW_PORT;
    const beforeReachable = await probePort('127.0.0.1', port);
    const runArgs = Object.assign({}, args || {}, {
        action: 'run',
        platform: (args && args.platform) || 'browser'
    });
    const result = await originalExecute.call(instance, 'editor', runArgs);
    const previewStatus = markStarted(runArgs, result, beforeReachable);
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
    const previewStatus = markStopped(stopArgs, result);
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

    CocosTools.prototype.getTools = function patchedGetTools() {
        const tools = originalGetTools.call(this);
        const definition = createPreviewToolDefinition();
        const index = tools.findIndex((tool) => tool && tool.name === definition.name);
        if (index >= 0) {
            tools[index] = definition;
        } else {
            tools.push(definition);
        }
        return tools;
    };

    CocosTools.prototype.execute = async function patchedExecute(toolName, args) {
        const normalizedName = toolName === 'cocos_editor' ? 'editor' : toolName;
        const action = args && args.action;

        if ((normalizedName === 'editor') && action === 'run') {
            return await runPreviewAction(this, originalExecute, args || {});
        }
        if ((normalizedName === 'editor') && action === 'stop') {
            return await stopPreviewAction(this, originalExecute, args || {});
        }
        if ((normalizedName === 'editor') && (action === 'preview_status' || action === 'get_preview_status')) {
            return {
                success: true,
                message: '已获取浏览器预览状态。',
                data: getPreviewStatus({ port: args && args.port })
            };
        }
        if (toolName === 'preview' || toolName === 'cocos_preview') {
            if (action === 'start') {
                return await runPreviewAction(this, originalExecute, args || {});
            }
            if (action === 'stop') {
                return await stopPreviewAction(this, originalExecute, args || {});
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

        return await originalExecute.call(this, toolName, args);
    };

    Object.defineProperty(CocosTools.prototype, PATCH_FLAG, {
        value: true,
        enumerable: false
    });
}

module.exports = { install };
