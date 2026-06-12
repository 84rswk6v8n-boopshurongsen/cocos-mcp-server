'use strict';

const PATCH_FLAG = Symbol.for('cocos-mcp-server.runtime-tools-patch.v1');
const RUNTIME_HANDLER_MODULE = './handlers/runtime-handler';

function createRuntimeHandler() {
    const handlerPath = require.resolve(RUNTIME_HANDLER_MODULE);
    delete require.cache[handlerPath];
    const { RuntimeHandler } = require(RUNTIME_HANDLER_MODULE);
    return new RuntimeHandler();
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
        const definition = createRuntimeHandler().getToolDefinition();
        const index = tools.findIndex((tool) => tool && tool.name === definition.name);
        if (index >= 0) {
            tools[index] = definition;
        } else {
            tools.push(definition);
        }
        return tools;
    };

    CocosTools.prototype.execute = async function patchedExecute(toolName, args) {
        if (toolName === 'runtime' || toolName === 'cocos_runtime') {
            try {
                return await createRuntimeHandler().execute(args || {});
            } catch (error) {
                return {
                    success: false,
                    error: error && error.message ? error.message : String(error)
                };
            }
        }
        return await originalExecute.call(this, toolName, args);
    };

    Object.defineProperty(CocosTools.prototype, PATCH_FLAG, {
        value: true,
        enumerable: false
    });
}

module.exports = { install };
