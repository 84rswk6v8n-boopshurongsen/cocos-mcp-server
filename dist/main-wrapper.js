'use strict';

function installAnimationMaskPatch(stage) {
    try {
        require('./tools/cocos/animation-mask-patch').install();
        console.log(`[cocos-mcp-server] animation_mask tool patch installed (${stage})`);
    } catch (error) {
        console.error(`[cocos-mcp-server] Failed to install animation_mask tool patch (${stage}):`, error);
    }
}

installAnimationMaskPatch('before-main');
const mainModule = require('./main');
installAnimationMaskPatch('after-main');

module.exports = mainModule;
