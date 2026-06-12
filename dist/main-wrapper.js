'use strict';

function installAnimationMaskPatch(stage) {
    try {
        require('./tools/cocos/animation-mask-patch').install();
        console.log(`[cocos-mcp-server] animation_mask tool patch installed (${stage})`);
    } catch (error) {
        console.error(`[cocos-mcp-server] Failed to install animation_mask tool patch (${stage}):`, error);
    }
}

function installPreviewStatusPatch(stage) {
    try {
        require('./tools/cocos/preview-status-patch').install();
    } catch (error) {
        console.error(`[cocos-mcp-server] Failed to install preview status patch (${stage}):`, error);
    }
}

function installRuntimePatch(stage) {
    try {
        require('./tools/cocos/runtime-patch').install();
    } catch (error) {
        console.error(`[cocos-mcp-server] Failed to install runtime patch (${stage}):`, error);
    }
}

installAnimationMaskPatch('before-main');
installPreviewStatusPatch('before-main');
installRuntimePatch('before-main');
const mainModule = require('./main');
installAnimationMaskPatch('after-main');
installPreviewStatusPatch('after-main');
installRuntimePatch('after-main');

module.exports = mainModule;
