'use strict';

const PATCH_FLAG = Symbol.for('cocos-mcp-server.animation-tools-patch.v1');
const MASK_HANDLER_MODULE = './handlers/animation-mask-handler';
const GRAPH_HANDLER_MODULE = './handlers/animation-graph-handler';

function createAnimationMaskHandler() {
    const handlerPath = require.resolve(MASK_HANDLER_MODULE);
    delete require.cache[handlerPath];
    const { AnimationMaskHandler } = require(MASK_HANDLER_MODULE);
    return new AnimationMaskHandler();
}

function createAnimationGraphHandler() {
    const handlerPath = require.resolve(GRAPH_HANDLER_MODULE);
    delete require.cache[handlerPath];
    const { AnimationGraphHandler } = require(GRAPH_HANDLER_MODULE);
    return new AnimationGraphHandler();
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
        for (const definition of [
            createAnimationMaskHandler().getToolDefinition(),
            createAnimationGraphHandler().getToolDefinition()
        ]) {
            const index = tools.findIndex((tool) => tool && tool.name === definition.name);
            if (index >= 0) {
                tools[index] = definition;
            } else {
                tools.push(definition);
            }
        }
        return tools;
    };

    CocosTools.prototype.execute = async function patchedExecute(toolName, args) {
        if (toolName === 'animation_mask' || toolName === 'cocos_animation_mask') {
            try {
                return await createAnimationMaskHandler().execute(args || {});
            } catch (error) {
                return {
                    success: false,
                    error: error && error.message ? error.message : String(error)
                };
            }
        }
        if (toolName === 'animation_graph' || toolName === 'cocos_animation_graph') {
            try {
                return await createAnimationGraphHandler().execute(args || {});
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
