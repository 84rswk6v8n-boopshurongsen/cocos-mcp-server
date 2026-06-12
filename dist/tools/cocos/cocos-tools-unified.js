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
        label: new FontHandler()
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
                console.error(`[CocosTools] 获取工具定义失败：${name}`, error && error.message ? error.message : error);
            }
        }

        upsertToolDefinitions(tools, getExtendedToolDefinitions());
        console.log(`[CocosTools] getTools() 已返回 ${tools.length} 个工具：${tools.map((tool) => tool.name).join(', ')}`);
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
                error: `未知 cocos 工具：${toolName}。可用工具：${Object.keys(this.handlers).join(', ')}`
            };
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
