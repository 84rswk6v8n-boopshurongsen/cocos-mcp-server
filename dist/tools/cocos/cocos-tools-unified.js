'use strict';

const { SceneHandler } = require('./handlers/scene-handler');
const { NodeHandler } = require('./handlers/node-handler');
const { ComponentHandler } = require('./handlers/component-handler');
const { PrefabHandler } = require('./handlers/prefab-handler');
const { AssetHandler } = require('./handlers/asset-handler');
const { EditorHandler } = require('./handlers/editor-handler');
const { ViewHandler } = require('./handlers/view-handler');
const { CompositeHandler } = require('./handlers/composite-handler');
const { KnowledgeHandler } = require('./handlers/knowledge-handler');
const { ValidateHandler } = require('./handlers/validate-handler');
const { TemplateHandler } = require('./handlers/template-handler');
const { CaptureHandler } = require('./handlers/capture-handler');
const { BuilderHandler } = require('./handlers/builder-handler');
const { AnimationHandler } = require('./handlers/animation-handler');
const { SpineHandler } = require('./handlers/spine-handler');
const { FontHandler } = require('./handlers/font-handler');
const { PhysicsHandler } = require('./handlers/physics-handler');
const { MaterialHandler } = require('./handlers/material-handler');
const { VfxHandler } = require('./handlers/vfx-handler');
const { ShaderDebugHandler } = require('./handlers/shader-debug-handler');
const { MessageRecorder } = require('./utils/message-recorder');
const { getExtendedToolDefinitions, executeExtendedTool } = require('./extended-tools-registry');

function isDebugMode() {
    try {
        return !!(globalThis.__cocosMcpDebugMode || process.env.COCOS_MCP_DEBUG === '1');
    }
    catch (_) {
        return false;
    }
}

function createCoreHandlers() {
    return {
        scene: new SceneHandler(),
        node: new NodeHandler(),
        component: new ComponentHandler(),
        prefab: new PrefabHandler(),
        asset: new AssetHandler(),
        editor: new EditorHandler(),
        view: new ViewHandler(),
        composite: new CompositeHandler(),
        knowledge: new KnowledgeHandler(),
        validate: new ValidateHandler(),
        template: new TemplateHandler(),
        capture: new CaptureHandler(),
        builder: new BuilderHandler(),
        animation: new AnimationHandler(),
        spine: new SpineHandler(),
        label: new FontHandler(),
        physics: new PhysicsHandler(),
        material: new MaterialHandler(),
        shader_debug: new ShaderDebugHandler(),
        vfx: new VfxHandler()
    };
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

function hasNonAscii(value) {
    return typeof value === 'string' && /[^\x00-\x7F]/.test(value);
}

function getAsciiToolDescription(toolName) {
    const readable = String(toolName || 'cocos_tool').replace(/^cocos_/, '').replace(/_/g, ' ');
    return `Cocos ${readable} tool. Use the action parameter to choose an operation.`;
}

function sanitizeSchemaDescriptions(value, path = []) {
    if (!value || typeof value !== 'object') {
        return value;
    }
    for (const [key, child] of Object.entries(value)) {
        const nextPath = path.concat(key);
        if (key === 'description' && hasNonAscii(child)) {
            const owner = path[path.length - 1] || 'value';
            value[key] = `Description for ${owner}.`;
            continue;
        }
        sanitizeSchemaDescriptions(child, nextPath);
    }
    return value;
}

function sanitizeToolDefinitionText(tool) {
    if (!tool || typeof tool !== 'object') {
        return tool;
    }
    if (hasNonAscii(tool.description)) {
        tool.description = getAsciiToolDescription(tool.name);
    }
    sanitizeSchemaDescriptions(tool.inputSchema);
    return tool;
}

function loadFreshToolGuides() {
    const guidePath = require.resolve('./data/tool-guides');
    delete require.cache[guidePath];
    return require('./data/tool-guides');
}

function normalizeKnowledgeToolName(toolName) {
    return String(toolName || '').trim().replace(/^cocos_/, '');
}

function queryToolGuide(args) {
    const query = String((args && args.query) || '').trim();
    const guides = loadFreshToolGuides();
    if (!query) {
        return {
            success: true,
            data: guides.getToolIndex(),
            message: 'Cocos MCP tool guide index loaded.'
        };
    }

    const parts = query.split('.');
    const toolName = normalizeKnowledgeToolName(parts[0]);
    const actionName = parts[1];
    if (actionName) {
        const actionGuide = guides.getActionGuide(toolName, actionName);
        if (!actionGuide) {
            const actionNames = guides.getActionNames(toolName);
            if (!actionNames) {
                return {
                    success: false,
                    error: `Unknown tool "${query}".`,
                    instruction: `Available tools: ${guides.getToolNames().join(', ')}`
                };
            }
            return {
                success: false,
                error: `Unknown action "${actionName}" for tool "${toolName}".`,
                instruction: `Available actions: ${actionNames.join(', ')}`
            };
        }
        return {
            success: true,
            data: actionGuide,
            message: `Tool guide for ${toolName}.${actionName}: ${actionGuide.desc || ''}`
        };
    }

    const toolGuide = guides.getToolGuide(toolName);
    if (!toolGuide) {
        return {
            success: false,
            error: `Unknown tool "${query}".`,
            instruction: `Available tools: ${guides.getToolNames().join(', ')}`
        };
    }
    return {
        success: true,
        data: toolGuide,
        message: `Tool "${toolName}": ${toolGuide.desc} Actions: ${Object.keys(toolGuide.actions || {}).join(', ')}`
    };
}

class CocosTools {
    constructor() {
        this.handlers = createCoreHandlers();

        if (isDebugMode()) {
            const { DevToolsHandler } = require('./handlers/devtools-handler');
            this.handlers.devtools = new DevToolsHandler();
        }
    }

    getTools() {
        const tools = [];
        for (const [name, handler] of Object.entries(this.handlers)) {
            try {
                const definition = handler.getToolDefinition();
                tools.push({
                    name: definition.name,
                    description: definition.description,
                    inputSchema: definition.inputSchema
                });
            }
            catch (error) {
                console.error(`[CocosTools] Failed to load tool definition: ${name}`, error && error.message ? error.message : error);
            }
        }

        upsertToolDefinitions(tools, getExtendedToolDefinitions());
        patchEditorRestartToolDefinition(tools);
        tools.forEach(sanitizeToolDefinitionText);
        console.log(`[CocosTools] getTools() returned ${tools.length} tools: ${tools.map((tool) => tool.name).join(', ')}`);
        return tools;
    }

    async execute(toolName, args) {
        const extendedResult = await executeExtendedTool(this, this.executeCoreTool, toolName, args);
        if (extendedResult) {
            return extendedResult;
        }

        return await this.executeCoreTool(toolName, args);
    }

    async executeCoreTool(toolName, args) {
        const handler = this.handlers[toolName];
        if (!handler) {
            return {
                success: false,
                error: `Unknown Cocos tool: ${toolName}. Available tools: ${Object.keys(this.handlers).join(', ')}`
            };
        }

        if (toolName === 'knowledge' && args && args.topic === 'tool_guide') {
            return queryToolGuide(args);
        }

        if (isDebugMode()) {
            const action = (args && args.action) || 'unknown';
            MessageRecorder.setSource(`mcp:${toolName}.${action}`);
            try {
                return await handler.execute(args);
            }
            finally {
                MessageRecorder.resetSource();
            }
        }

        return await handler.execute(args);
    }
}

exports.CocosTools = CocosTools;
