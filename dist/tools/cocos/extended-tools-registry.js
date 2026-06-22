'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const PATCH_FLAG = Symbol.for('cocos-mcp-server.extended-tools-registry.v1');
const DEFAULT_PREVIEW_PORT = 7456;

const EXTENDED_TOOL_NAMES = [
    'cocos_animation_mask',
    'cocos_animation_graph',
    'cocos_preview',
    'cocos_runtime',
    'cocos_physics',
    'cocos_material',
    'cocos_restart'
];

function createFreshHandler(modulePath, exportName) {
    const handlerPath = require.resolve(modulePath);
    delete require.cache[handlerPath];
    const handlerModule = require(modulePath);
    const HandlerClass = handlerModule && handlerModule[exportName];
    if (!HandlerClass) {
        throw new Error(`Extended tool handler was not found: ${exportName}`);
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

function createPhysicsHandler() {
    return createFreshHandler('./handlers/physics-handler', 'PhysicsHandler');
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

function getProjectPath() {
    try {
        if (globalThis.Editor && Editor.Project && Editor.Project.path) {
            return Editor.Project.path;
        }
    }
    catch (_) {}
    return process.cwd();
}

function getCreatorVersion() {
    try {
        const execPath = process.execPath || '';
        const parent = path.basename(path.dirname(execPath));
        if (/^\d+\.\d+\.\d+/.test(parent)) {
            return parent;
        }
    }
    catch (_) {}
    try {
        if (globalThis.Editor && Editor.App && Editor.App.version) {
            return Editor.App.version;
        }
    }
    catch (_) {}
    return '';
}

function getRestartStatus() {
    const dashboardIpcAvailable = typeof process.send === 'function';
    return {
        dashboardIpcAvailable,
        projectPath: getProjectPath(),
        creatorVersion: getCreatorVersion(),
        processPid: process.pid,
        processExecPath: process.execPath,
        preservesLoginState: dashboardIpcAvailable,
        message: dashboardIpcAvailable
            ? 'Dashboard restart IPC is available.'
            : 'Dashboard restart IPC is unavailable. External restart fallback is disabled.'
    };
}

function createRestartToolDefinition() {
    return {
        name: 'restart',
        description: [
            'Restart Cocos Creator from MCP.',
            'This uses the Cocos Dashboard editor-restart IPC so Dashboard login state is preserved.',
            'External restart fallback is disabled.',
            'Use this MCP tool directly; do not call plugin restart methods through cocos_scene.execute_script because that path only reports script dispatch success.'
        ].join('\n'),
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['status', 'restart'],
                    description: 'status checks the restart path; restart requests an editor restart.'
                },
                preferDashboard: {
                    type: 'boolean',
                    description: 'Use Dashboard IPC when available. Default true.'
                },
                dryRun: {
                    type: 'boolean',
                    description: 'Return the planned restart path without restarting.'
                }
            },
            required: ['action']
        }
    };
}

async function executeRestartTool(args = {}) {
    const action = args.action;
    const status = getRestartStatus();

    if (action === 'status' || args.dryRun) {
        return {
            success: true,
            message: status.message,
            data: Object.assign({}, status, {
                dryRun: !!args.dryRun,
                plannedMethod: status.dashboardIpcAvailable && args.preferDashboard !== false
                    ? 'dashboard editor-restart ipc'
                    : 'none'
            })
        };
    }

    if (action !== 'restart') {
        return {
            success: false,
            error: `Unknown preview action: ${action || ''}`,
            data: status
        };
    }

    if (args.preferDashboard !== false && status.dashboardIpcAvailable) {
        process.send({ channel: 'editor-restart' });
        return {
            success: true,
            message: 'Cocos Creator restart requested through Cocos Dashboard.',
            data: Object.assign({}, status, {
                quitMethod: 'dashboard editor-restart ipc'
            })
        };
    }

    return {
        success: false,
        message: 'Dashboard restart IPC is unavailable. External restart fallback is disabled.',
        data: Object.assign({}, status, {
            quitMethod: 'none'
        })
    };
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

function shouldReuseRunningPreview(args, beforeReachable) {
    if (!beforeReachable) {
        return false;
    }
    const options = args || {};
    if (options.forceOpen === true || options.openBrowser === true) {
        return false;
    }
    if (options.reuseExisting === false) {
        return false;
    }
    return true;
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

function createLegacyPreviewToolDefinition() {
    return {
        name: 'preview',
        description: 'Cocos browser preview helper. Start or stop preview and return preview state, launch time, URLs, and reuse information.',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['start', 'stop', 'status'],
                    description: 'Preview action: start, stop, or status.'
                },
                platform: {
                    type: 'string',
                    description: 'Preview platform, usually browser.'
                },
                port: {
                    type: 'number',
                    description: 'Preview server port. Default is 7456.'
                }
            },
            required: ['action']
        }
    };
}

function createPreviewToolDefinition() {
    return {
        name: 'preview',
        description: [
            'Cocos browser preview helper. Start or stop preview and return preview state, launch time, URLs, and reuse information.',
            'When a preview server is already running, start reuses it silently by default and does not reopen the raw preview page.',
            'For visual debug overlays, prefer cocos_runtime.open_injected_preview in an external system browser.'
        ].join('\n'),
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['start', 'stop', 'status'],
                    description: 'Preview action: start or reuse, stop, or status.'
                },
                platform: {
                    type: 'string',
                    description: 'Preview platform, usually browser.'
                },
                port: {
                    type: 'number',
                    description: 'Preview server port. Default is 7456.'
                },
                reuseExisting: {
                    type: 'boolean',
                    description: 'Reuse an existing preview server on the same port. Default is true; false requests a new Cocos preview start.'
                },
                openBrowser: {
                    type: 'boolean',
                    description: 'Force opening the raw preview browser page. Default is false; keep false for visual debug and use cocos_runtime.open_injected_preview.'
                },
                forceOpen: {
                    type: 'boolean',
                    description: 'Alias for openBrowser. If true, calls Cocos run browser even when the port is already reachable.'
                }
            },
            required: ['action']
        }
    };
}

function patchEditorRestartToolDefinition(tools) {
    const editorTool = tools.find((tool) => tool && (tool.name === 'editor' || tool.name === 'cocos_editor'));
    if (!editorTool || !editorTool.inputSchema || !editorTool.inputSchema.properties) {
        return tools;
    }

    const properties = editorTool.inputSchema.properties;
    if (properties.action && Array.isArray(properties.action.enum)) {
        for (const actionName of ['restart', 'restart_status']) {
            if (!properties.action.enum.includes(actionName)) {
                properties.action.enum.push(actionName);
            }
        }
    }

    properties.preferDashboard = properties.preferDashboard || {
        type: 'boolean',
        description: 'Restart actions: use Cocos Dashboard IPC when available. Default true.'
    };
    if (properties.allowDirectFallback) {
        delete properties.allowDirectFallback;
    }
    properties.dryRun = properties.dryRun || {
        type: 'boolean',
        description: 'Restart actions: return the planned restart path without restarting.'
    };

    const restartNote = 'Restart actions: use restart_status to check Dashboard IPC and restart to request a Dashboard-preserving editor restart.';
    if (typeof editorTool.description === 'string' && !editorTool.description.includes('restart_status')) {
        editorTool.description = `${editorTool.description}\n${restartNote}`;
    }
    return tools;
}

function getExtendedToolDefinitions() {
    return [
        createAnimationMaskHandler().getToolDefinition(),
        createAnimationGraphHandler().getToolDefinition(),
        createPreviewToolDefinition(),
        createRestartToolDefinition(),
        createRuntimeHandler().getToolDefinition(),
        createPhysicsHandler().getToolDefinition()
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
    patchEditorRestartToolDefinition(tools);
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
    if (shouldReuseRunningPreview(args, beforeReachable)) {
        const runArgs = Object.assign({}, args || {}, {
            action: 'run',
            platform: (args && args.platform) || 'browser'
        });
        const result = {
            success: true,
            message: 'Preview server is already running; reused the existing preview server silently.',
            data: {
                platform: runArgs.platform,
                reusedExistingServer: true,
                openedRawPreview: false
            }
        };
        const previewStatus = markPreviewStarted(runArgs, result, beforeReachable);
        return Object.assign({}, result, {
            data: Object.assign({}, result.data, { previewStatus })
        });
    }
    const runArgs = Object.assign({}, args || {}, {
        action: 'run',
        platform: (args && args.platform) || 'browser'
    });
    const result = await originalExecute.call(instance, 'editor', runArgs);
    const previewStatus = markPreviewStarted(runArgs, result, beforeReachable);
    if (result && typeof result === 'object') {
        return Object.assign({}, result, {
            message: result.message || 'Browser preview started.',
            data: Object.assign({}, result.data || {}, { previewStatus })
        });
    }
    return {
        success: true,
        message: 'Browser preview started.',
        data: { result, previewStatus }
    };
}

async function stopPreviewAction(instance, originalExecute, args) {
    const stopArgs = Object.assign({}, args || {}, { action: 'stop' });
    const result = await originalExecute.call(instance, 'editor', stopArgs);
    const previewStatus = markPreviewStopped(stopArgs, result);
    if (result && typeof result === 'object') {
        return Object.assign({}, result, {
            message: result.message || 'Browser preview stopped.',
            data: Object.assign({}, result.data || {}, { previewStatus })
        });
    }
    return {
        success: true,
        message: 'Browser preview stopped.',
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
            message: 'Browser preview status loaded.',
            data: getPreviewStatus({ port: args && args.port })
        };
    }
    return {
        success: false,
        error: `Unknown preview action: ${action || ''}`
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
            message: 'Browser preview status loaded.',
            data: getPreviewStatus({ port: args && args.port })
        };
    }

    if (normalizedName === 'editor' && (action === 'restart' || action === 'restart_status')) {
        const restartArgs = Object.assign({}, args || {}, {
            action: action === 'restart' ? 'restart' : 'status'
        });
        return await executeRestartTool(restartArgs);
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
    if (isToolName(toolName, 'restart')) {
        return await executeRestartTool(args || {});
    }
    if (isToolName(toolName, 'runtime')) {
        return await executeHandler(createRuntimeHandler, args);
    }
    if (isToolName(toolName, 'physics')) {
        return await executeHandler(createPhysicsHandler, args);
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
