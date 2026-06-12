'use strict';

(function () {
    const VERSION = '0.1.1';
    const currentScript = document.currentScript;
    const scriptUrl = currentScript && currentScript.src ? currentScript.src : '';
    const baseUrl = scriptUrl ? scriptUrl.replace(/\/runtime\/bridge\.js(?:\?.*)?$/, '') : 'http://127.0.0.1:3300';
    const state = {
        version: VERSION,
        baseUrl,
        clientId: null,
        connected: false,
        lastError: null,
        lastRegisterAt: null,
        lastHeartbeatAt: null,
        lastCommandAt: null
    };

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function getCc() {
        return window.cc || globalThis.cc || null;
    }

    function getScene() {
        const cc = getCc();
        try {
            return cc && cc.director && typeof cc.director.getScene === 'function'
                ? cc.director.getScene()
                : null;
        } catch (_) {
            return null;
        }
    }

    function getSceneName(scene) {
        return scene && scene.name || document.title || location.pathname || 'Scene';
    }

    function isRuntimeReady(options) {
        const cc = getCc();
        const scene = getScene();
        const requireNodes = !(options && options.requireNodes === false);
        return !!(cc && cc.director && scene && (!requireNodes || getChildren(scene).length > 0));
    }

    function getNodeUuid(node) {
        return String((node && (node.uuid || node._id || node._uuid)) || '');
    }

    function getComponentUuid(component) {
        return String((component && (component.uuid || component._id || component._uuid)) || '');
    }

    function getComponentType(component) {
        if (!component) {
            return 'UnknownComponent';
        }
        return component.__classname__
            || component.constructor && (component.constructor.__classname__ || component.constructor.name)
            || component.name
            || 'UnknownComponent';
    }

    function toPlainVec(value) {
        if (!value || typeof value !== 'object') {
            return null;
        }
        const result = {};
        for (const key of ['x', 'y', 'z', 'w']) {
            if (typeof value[key] === 'number') {
                result[key] = value[key];
            }
        }
        return Object.keys(result).length ? result : null;
    }

    function readPosition(node) {
        try {
            const value = node && typeof node.getPosition === 'function' ? node.getPosition() : node && node.position;
            return toPlainVec(value) || {
                x: Number(node && node.x) || 0,
                y: Number(node && node.y) || 0,
                z: Number(node && node.z) || 0
            };
        } catch (_) {
            return null;
        }
    }

    function readRotation(node) {
        try {
            const value = node && (node.eulerAngles || node.rotation || node.angle);
            if (typeof value === 'number') {
                return { x: 0, y: 0, z: value };
            }
            return toPlainVec(value);
        } catch (_) {
            return null;
        }
    }

    function readScale(node) {
        try {
            const value = node && typeof node.getScale === 'function' ? node.getScale() : node && node.scale;
            return toPlainVec(value) || {
                x: Number(node && node.scaleX) || 1,
                y: Number(node && node.scaleY) || 1,
                z: Number(node && node.scaleZ) || 1
            };
        } catch (_) {
            return null;
        }
    }

    function getChildren(node) {
        return Array.isArray(node && node.children) ? node.children : [];
    }

    function getComponents(node) {
        return Array.isArray(node && node.components)
            ? node.components
            : Array.isArray(node && node._components)
                ? node._components
                : [];
    }

    function componentSummary(component) {
        return {
            uuid: getComponentUuid(component),
            type: getComponentType(component),
            enabled: typeof component.enabled === 'boolean' ? component.enabled : null
        };
    }

    function nodeSummary(node, path) {
        return {
            name: String(node && node.name || ''),
            uuid: getNodeUuid(node),
            active: node && typeof node.active === 'boolean' ? node.active : true,
            path,
            position: readPosition(node),
            rotation: readRotation(node),
            scale: readScale(node),
            components: getComponents(node).map(componentSummary)
        };
    }

    function walkNodes(root, visitor, path) {
        if (!root) {
            return;
        }
        visitor(root, path);
        for (const child of getChildren(root)) {
            const childPath = path ? `${path}/${child.name || ''}` : String(child.name || '');
            walkNodes(child, visitor, childPath);
        }
    }

    function buildSceneTree(node, path, options, depth) {
        const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 99;
        const keyword = String(options.nameKeyword || '').trim().toLowerCase();
        const current = {
            name: String(node && node.name || ''),
            uuid: getNodeUuid(node),
            active: node && typeof node.active === 'boolean' ? node.active : true,
            path,
            children: []
        };
        if (depth >= maxDepth) {
            return current;
        }
        for (const child of getChildren(node)) {
            const childPath = path ? `${path}/${child.name || ''}` : String(child.name || '');
            const childTree = buildSceneTree(child, childPath, options, depth + 1);
            if (!keyword || childTree.name.toLowerCase().includes(keyword) || childTree.path.toLowerCase().includes(keyword) || childTree.children.length) {
                current.children.push(childTree);
            }
        }
        return current;
    }

    function collectNodes() {
        const scene = getScene();
        const nodes = [];
        if (!scene) {
            return nodes;
        }
        for (const child of getChildren(scene)) {
            walkNodes(child, (node, path) => nodes.push({ node, path }), String(child.name || ''));
        }
        return nodes;
    }

    function findNode(ref) {
        const query = String(ref || '').trim();
        if (!query) {
            return null;
        }
        const nodes = collectNodes();
        return nodes.find((item) => getNodeUuid(item.node) === query)
            || nodes.find((item) => item.path === query)
            || nodes.find((item) => item.node && item.node.name === query)
            || null;
    }

    function findNodes(args) {
        const query = String(args.query || args.node || '').trim();
        const lower = query.toLowerCase();
        const nodes = collectNodes();
        if (!query) {
            return [];
        }
        const exact = nodes.filter((item) => getNodeUuid(item.node) === query || item.path === query || item.node.name === query);
        const source = exact.length ? exact : nodes.filter((item) => {
            return getNodeUuid(item.node).toLowerCase().includes(lower)
                || item.path.toLowerCase().includes(lower)
                || String(item.node.name || '').toLowerCase().includes(lower);
        });
        return source.map((item) => {
            const summary = nodeSummary(item.node, item.path);
            return {
                name: summary.name,
                uuid: summary.uuid,
                path: summary.path,
                active: summary.active,
                components: summary.components.map((component) => component.type)
            };
        });
    }

    function safeValue(value, depth, seen) {
        if (value === null || value === undefined) {
            return value;
        }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'function') {
            return undefined;
        }
        if (depth > 2) {
            return '[Object]';
        }
        const vec = toPlainVec(value);
        if (vec) {
            return vec;
        }
        if (typeof value.r === 'number' && typeof value.g === 'number' && typeof value.b === 'number') {
            return {
                r: value.r,
                g: value.g,
                b: value.b,
                a: typeof value.a === 'number' ? value.a : 255
            };
        }
        if (seen.has(value)) {
            return '[Circular]';
        }
        seen.add(value);
        if (Array.isArray(value)) {
            return value.slice(0, 20).map((item) => safeValue(item, depth + 1, seen)).filter((item) => item !== undefined);
        }
        const result = {};
        for (const key of Object.keys(value).slice(0, 40)) {
            if (key.startsWith('_')) {
                continue;
            }
            try {
                const child = safeValue(value[key], depth + 1, seen);
                if (child !== undefined) {
                    result[key] = child;
                }
            } catch (_) {
            }
        }
        return result;
    }

    function componentInfo(args) {
        const found = findNode(args.node);
        if (!found) {
            return { success: false, error: `未找到节点：${args.node || ''}` };
        }
        const componentName = String(args.component || args.componentType || '').trim();
        const components = getComponents(found.node);
        const component = components.find((item) => getComponentUuid(item) === componentName || getComponentType(item) === componentName || getComponentType(item).endsWith(componentName));
        if (!component) {
            return { success: false, error: `节点 ${found.path} 上未找到组件：${componentName}` };
        }
        return {
            success: true,
            data: {
                node: found.path,
                component: componentSummary(component),
                properties: safeValue(component, 0, new WeakSet())
            }
        };
    }

    function setNodeActive(args) {
        const found = findNode(args.node);
        if (!found) {
            return { success: false, error: `未找到节点：${args.node || ''}` };
        }
        const before = !!found.node.active;
        found.node.active = !!args.active;
        return {
            success: true,
            data: {
                node: found.path,
                before,
                active: !!found.node.active
            }
        };
    }

    function mergeVec(current, next, fallback) {
        return {
            x: Number(next && next.x !== undefined ? next.x : current && current.x !== undefined ? current.x : fallback.x),
            y: Number(next && next.y !== undefined ? next.y : current && current.y !== undefined ? current.y : fallback.y),
            z: Number(next && next.z !== undefined ? next.z : current && current.z !== undefined ? current.z : fallback.z)
        };
    }

    function setNodeTransform(args) {
        const found = findNode(args.node);
        if (!found) {
            return { success: false, error: `未找到节点：${args.node || ''}` };
        }
        const node = found.node;
        const before = {
            position: readPosition(node),
            rotation: readRotation(node),
            scale: readScale(node)
        };
        const cc = getCc();
        if (args.position) {
            const value = mergeVec(before.position, args.position, { x: 0, y: 0, z: 0 });
            if (typeof node.setPosition === 'function') {
                node.setPosition(value.x, value.y, value.z);
            } else if (cc && typeof cc.v3 === 'function') {
                node.position = cc.v3(value.x, value.y, value.z);
            } else {
                node.x = value.x;
                node.y = value.y;
                node.z = value.z;
            }
        }
        if (args.rotation) {
            const value = mergeVec(before.rotation, args.rotation, { x: 0, y: 0, z: 0 });
            if (typeof node.setRotationFromEuler === 'function') {
                node.setRotationFromEuler(value.x, value.y, value.z);
            } else if (cc && typeof cc.v3 === 'function') {
                node.eulerAngles = cc.v3(value.x, value.y, value.z);
            } else {
                node.angle = value.z;
            }
        }
        if (args.scale) {
            const value = mergeVec(before.scale, args.scale, { x: 1, y: 1, z: 1 });
            if (typeof node.setScale === 'function') {
                node.setScale(value.x, value.y, value.z);
            } else if (cc && typeof cc.v3 === 'function') {
                node.scale = cc.v3(value.x, value.y, value.z);
            } else {
                node.scaleX = value.x;
                node.scaleY = value.y;
                node.scaleZ = value.z;
            }
        }
        return {
            success: true,
            data: {
                node: found.path,
                before,
                after: {
                    position: readPosition(node),
                    rotation: readRotation(node),
                    scale: readScale(node)
                }
            }
        };
    }

    function runtimeStats() {
        const scene = getScene();
        const sceneRootCount = scene ? 1 : 0;
        let nodeCount = 0;
        let activeNodeCount = 0;
        let componentCount = 0;
        const componentTypes = {};
        for (const item of collectNodes()) {
            nodeCount++;
            if (item.node && item.node.active) {
                activeNodeCount++;
            }
            for (const component of getComponents(item.node)) {
                componentCount++;
                const type = getComponentType(component);
                componentTypes[type] = (componentTypes[type] || 0) + 1;
            }
        }
        return {
            sceneName: getSceneName(scene),
            sceneIncluded: false,
            sceneRootCount,
            nodeCount,
            activeNodeCount,
            componentCount,
            componentTypes,
            fps: null,
            drawCalls: null,
            url: location.href
        };
    }

    function checkSupport() {
        const cc = getCc();
        const scene = getScene();
        const childCount = scene ? getChildren(scene).length : 0;
        return {
            support: !!cc,
            hasCc: !!cc,
            hasDirector: !!(cc && cc.director),
            ready: isRuntimeReady({ requireNodes: false }),
            hasScene: !!scene,
            sceneName: getSceneName(scene),
            sceneChildCount: childCount,
            url: location.href,
            bridgeVersion: VERSION
        };
    }

    async function waitUntilReady(args) {
        const timeoutMs = Number(args && args.timeoutMs) || 10000;
        const intervalMs = Number(args && args.intervalMs) || 300;
        const requireNodes = !(args && args.requireNodes === false);
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            if (isRuntimeReady({ requireNodes })) {
                return {
                    success: true,
                    data: Object.assign(checkSupport(), runtimeStats())
                };
            }
            await sleep(intervalMs);
        }
        return {
            success: false,
            error: '等待 Cocos 运行场景就绪超时。',
            data: checkSupport()
        };
    }

    async function execute(command) {
        const action = command && command.action;
        const args = command && command.args || {};
        switch (action) {
            case 'check_support':
                return { success: true, data: checkSupport() };
            case 'wait_until_ready':
                return await waitUntilReady(args);
            case 'get_scene_tree': {
                if (args.waitReady !== false && !isRuntimeReady({ requireNodes: true })) {
                    const initialReadyResult = await waitUntilReady({
                        timeoutMs: args.readyTimeoutMs || args.timeoutMs || 10000,
                        requireNodes: true
                    });
                    if (!initialReadyResult.success) {
                        return initialReadyResult;
                    }
                }
                const scene = getScene();
                if (!scene) {
                    return { success: false, error: '当前网页没有可读取的 Cocos 运行场景。' };
                }
                if (args.waitReady !== false && !isRuntimeReady({ requireNodes: true })) {
                    const readyResult = await waitUntilReady({
                        timeoutMs: args.readyTimeoutMs || args.timeoutMs || 10000,
                        requireNodes: true
                    });
                    if (!readyResult.success) {
                        return readyResult;
                    }
                }
                const root = {
                    name: getSceneName(scene),
                    uuid: getNodeUuid(scene),
                    active: true,
                    path: '',
                    sceneIncluded: true,
                    nodeCountExcludingScene: collectNodes().length,
                    children: getChildren(scene).map((child) => buildSceneTree(child, String(child.name || ''), args, 0))
                };
                return { success: true, data: root };
            }
            case 'find_node':
                return { success: true, data: findNodes(args) };
            case 'get_node_info': {
                const found = findNode(args.node || args.query || args.uuid || args.path);
                if (!found) {
                    return { success: false, error: `未找到节点：${args.node || args.query || args.uuid || args.path || ''}` };
                }
                return { success: true, data: nodeSummary(found.node, found.path) };
            }
            case 'get_component_info':
                return componentInfo(args);
            case 'set_node_active':
                return setNodeActive(args);
            case 'set_node_transform':
                return setNodeTransform(args);
            case 'get_runtime_stats':
                if (args.waitReady !== false && !isRuntimeReady({ requireNodes: true })) {
                    const readyResult = await waitUntilReady({
                        timeoutMs: args.readyTimeoutMs || args.timeoutMs || 10000,
                        requireNodes: true
                    });
                    if (!readyResult.success) {
                        return readyResult;
                    }
                }
                return { success: true, data: runtimeStats() };
            default:
                return { success: false, error: `未知运行态操作：${action || ''}` };
        }
    }

    async function request(path, options) {
        const response = await fetch(`${baseUrl}${path}`, Object.assign({
            cache: 'no-store'
        }, options || {}));
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
    }

    async function post(path, payload) {
        return await request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {})
        });
    }

    async function register() {
        const result = await post('/runtime/register', {
            url: location.href,
            title: document.title,
            userAgent: navigator.userAgent,
            support: checkSupport()
        });
        state.clientId = result.clientId;
        state.connected = true;
        state.lastRegisterAt = new Date().toISOString();
        state.lastError = null;
        return result;
    }

    async function sendResult(commandId, result) {
        await post('/runtime/result', {
            clientId: state.clientId,
            commandId,
            result
        });
    }

    async function heartbeat() {
        if (!state.clientId) {
            return;
        }
        await post('/runtime/heartbeat', {
            clientId: state.clientId,
            support: checkSupport()
        });
        state.lastHeartbeatAt = new Date().toISOString();
    }

    async function pollLoop() {
        while (true) {
            try {
                if (!state.clientId) {
                    await register();
                }
                const payload = await request(`/runtime/poll?clientId=${encodeURIComponent(state.clientId)}`);
                if (payload && payload.type === 'command' && payload.command) {
                    state.lastCommandAt = new Date().toISOString();
                    let result;
                    try {
                        result = await execute(payload.command);
                    } catch (error) {
                        result = {
                            success: false,
                            error: error && error.message ? error.message : String(error)
                        };
                    }
                    await sendResult(payload.command.id, result);
                }
            } catch (error) {
                state.connected = false;
                state.lastError = error && error.message ? error.message : String(error);
                state.clientId = null;
                await sleep(1000);
            }
        }
    }

    window.__cocosMcpRuntimeBridge = {
        state,
        checkSupport,
        getSceneTree: function (options) {
            return execute({ action: 'get_scene_tree', args: options || {} });
        },
        findNode: function (query) {
            return execute({ action: 'find_node', args: { query } });
        },
        getNodeInfo: function (node) {
            return execute({ action: 'get_node_info', args: { node } });
        }
    };

    setInterval(() => {
        heartbeat().catch(() => {});
    }, 3000);
    pollLoop();
})();
