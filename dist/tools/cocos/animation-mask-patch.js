'use strict';

const { AnimationMaskHandler } = require('./handlers/animation-mask-handler');

const PATCH_FLAG = Symbol.for('cocos-mcp-server.animation-mask-patch');

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
    const handlers = new WeakMap();

    const getHandler = (instance) => {
        let handler = handlers.get(instance);
        if (!handler) {
            handler = new AnimationMaskHandler();
            handlers.set(instance, handler);
        }
        return handler;
    };

    CocosTools.prototype.getTools = function patchedGetTools() {
        const tools = originalGetTools.call(this);
        if (!tools.some((tool) => tool && tool.name === 'animation_mask')) {
            tools.push(getHandler(this).getToolDefinition());
        }
        return tools;
    };

    CocosTools.prototype.execute = async function patchedExecute(toolName, args) {
        if (toolName === 'animation_mask') {
            try {
                return await getHandler(this).execute(args || {});
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
