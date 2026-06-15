'use strict';

(function () {
    const VERSION = '0.1.19';
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
    const consoleLogs = window.__cocosMcpConsoleLogs || (window.__cocosMcpConsoleLogs = []);
    const CONSOLE_LOG_LIMIT = 500;
    const debugDrawState = window.__cocosMcpPhysicsDebugDraw || (window.__cocosMcpPhysicsDebugDraw = {
        canvas: null,
        context: null,
        panel: null,
        drawings: [],
        stashedDrawings: [],
        nextId: 1,
        raf: 0,
        enabled: true,
        visibleRays: true,
        visibleColliders: true,
        panelVisible: true,
        panelX: 16,
        panelY: 72
    });
    debugDrawState.enabled = debugDrawState.enabled !== false;
    debugDrawState.visibleRays = debugDrawState.visibleRays !== false;
    debugDrawState.visibleColliders = debugDrawState.visibleColliders !== false;
    debugDrawState.panelVisible = debugDrawState.panelVisible !== false;
    debugDrawState.panelX = Number(debugDrawState.panelX) || 16;
    debugDrawState.panelY = Number(debugDrawState.panelY) || 72;
    debugDrawState.stashedDrawings = Array.isArray(debugDrawState.stashedDrawings) ? debugDrawState.stashedDrawings : [];

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function safeConsoleArg(value) {
        if (value === null || value === undefined) {
            return value;
        }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return value;
        }
        if (value instanceof Error || value && (value.name || value.message || value.stack) && typeof value !== 'function') {
            return {
                name: value.name || '',
                message: value.message || '',
                stack: value.stack || ''
            };
        }
        if (value && typeof value === 'object' && (value.type || value.target || value.currentTarget)) {
            const target = value.target || value.currentTarget || null;
            return {
                type: value.type || '',
                message: value.message || '',
                target: target && (target.src || target.href || target.currentSrc || target.tagName || target.nodeName) || ''
            };
        }
        try {
            return safeValue(value, 0, new WeakSet(), { maxDepth: 1, maxArrayLength: 10 });
        } catch (_) {
            try {
                return String(value);
            } catch (error) {
                return '[Unserializable]';
            }
        }
    }

    function recordConsole(level, args) {
        const values = Array.prototype.slice.call(args || []).map(safeConsoleArg);
        const text = values.map((item) => {
            if (typeof item === 'string') {
                return item;
            }
            try {
                return JSON.stringify(item);
            } catch (_) {
                return String(item);
            }
        }).join(' ');
        const finalText = text && text.trim() ? text : `[${level}] empty log content`;
        consoleLogs.push({
            index: consoleLogs.length + 1,
            level,
            time: new Date().toISOString(),
            text: finalText,
            values
        });
        if (consoleLogs.length > CONSOLE_LOG_LIMIT) {
            consoleLogs.splice(0, consoleLogs.length - CONSOLE_LOG_LIMIT);
        }
    }

    function defineConsoleHidden(target, key, value) {
        try {
            Object.defineProperty(target, key, {
                value,
                enumerable: false,
                configurable: true
            });
        } catch (_) {
            try {
                target[key] = value;
            } catch (_) {
            }
        }
    }

    function installConsoleCapture() {
        if (!window.console) {
            return;
        }
        const originals = window.console.__cocosMcpOriginals || {};
        for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
            if (!originals[level]) {
                originals[level] = typeof window.console[level] === 'function'
                    ? window.console[level].bind(window.console)
                    : function () {};
            }
            const original = originals[level];
            window.console[level] = function () {
                try {
                    recordConsole(level, arguments);
                } catch (_) {
                }
                return original.apply(null, arguments);
            };
        }
        defineConsoleHidden(window.console, '__cocosMcpOriginals', originals);
        defineConsoleHidden(window.console, '__cocosMcpCaptured', true);
        defineConsoleHidden(window.console, '__cocosMcpCaptureVersion', VERSION);
    }

    function installRuntimeErrorCapture() {
        if (window.__cocosMcpRuntimeErrorCaptureVersion === VERSION) {
            return;
        }
        defineConsoleHidden(window, '__cocosMcpRuntimeErrorCaptureVersion', VERSION);
        window.addEventListener('error', function (event) {
            try {
                const target = event && event.target;
                const resource = target && target !== window ? {
                    tagName: target.tagName || '',
                    src: target.src || '',
                    href: target.href || ''
                } : null;
                recordConsole('error', [{
                    type: resource ? 'resource-error' : 'window-error',
                    message: event && event.message || '',
                    filename: event && event.filename || '',
                    lineno: event && event.lineno || 0,
                    colno: event && event.colno || 0,
                    resource,
                    error: event && event.error ? {
                        name: event.error.name || '',
                        message: event.error.message || '',
                        stack: event.error.stack || ''
                    } : null
                }]);
            } catch (_) {
            }
        }, true);
        window.addEventListener('unhandledrejection', function (event) {
            try {
                recordConsole('error', [{
                    type: 'unhandledrejection',
                    reason: safeConsoleArg(event && event.reason)
                }]);
            } catch (_) {
            }
        });
    }

    function flushEarlyRuntimeErrors() {
        try {
            const errors = Array.isArray(window.__cocosMcpEarlyErrors) ? window.__cocosMcpEarlyErrors : [];
            for (const item of errors.splice(0, errors.length)) {
                recordConsole('error', [{
                    type: 'early-runtime-error',
                    detail: item
                }]);
            }
        } catch (_) {
        }
    }

    function getCc() {
        return window.cc || globalThis.cc || window._cclegacy || globalThis._cclegacy || null;
    }

    function getDirector(cc) {
        return cc && (cc.director || cc.Director && cc.Director.instance) || null;
    }

    function getNodeName(node) {
        return String(node && (node.name || node._name) || '');
    }

    function getNodeChildren(node) {
        return Array.isArray(node && node.children)
            ? node.children
            : Array.isArray(node && node._children)
                ? node._children
                : [];
    }

    function isNodeActive(node) {
        return node && typeof node.active === 'boolean' ? node.active : true;
    }

    function looksLikeScene(value) {
        return !!(value
            && typeof value === 'object'
            && (Array.isArray(value.children) || Array.isArray(value._children))
            && (typeof value.name === 'string' || typeof value._name === 'string' || value.isValid !== undefined));
    }

    function getSceneInfo() {
        const cc = getCc();
        const director = getDirector(cc);
        const candidates = [];
        try {
            if (director && typeof director.getScene === 'function') {
                candidates.push({ source: 'director.getScene()', scene: director.getScene() });
            }
        } catch (_) {
        }
        for (const key of ['_scene', 'scene', '_runningScene', '_currentScene', '_sceneAsset']) {
            try {
                if (director && director[key]) {
                    candidates.push({ source: `director.${key}`, scene: director[key] });
                }
            } catch (_) {
            }
        }
        try {
            if (cc && cc.game && cc.game._scene) {
                candidates.push({ source: 'cc.game._scene', scene: cc.game._scene });
            }
        } catch (_) {
        }
        for (const item of candidates) {
            if (looksLikeScene(item.scene)) {
                return item;
            }
        }
        return candidates.find((item) => item.scene) || { source: '', scene: null };
    }

    function getScene() {
        return getSceneInfo().scene;
    }

    function getSceneSource() {
        return getSceneInfo().source || '';
    }

    function getRuntimeDiagnostics(cc, scene) {
        const director = getDirector(cc);
        const keys = [];
        try {
            if (director) {
                for (const key of Object.keys(director).slice(0, 40)) {
                    keys.push(key);
                }
            }
        } catch (_) {
        }
        return {
            ccGlobal: window.cc ? 'window.cc' : window._cclegacy ? 'window._cclegacy' : '',
            sceneSource: getSceneSource(),
            sceneType: scene && scene.constructor && (scene.constructor.__classname__ || scene.constructor.name) || '',
            directorKeys: keys
        };
    }

    function getSceneName(scene) {
        return getNodeName(scene) || document.title || location.pathname || 'Scene';
    }

    function isRuntimeReady(options) {
        const cc = getCc();
        const scene = getScene();
        const requireNodes = !(options && options.requireNodes === false);
        return !!(cc && getDirector(cc) && scene && (!requireNodes || getChildren(scene).length > 0));
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
        return getNodeChildren(node);
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
            name: getNodeName(node),
            uuid: getNodeUuid(node),
            active: isNodeActive(node),
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
            const childName = getNodeName(child);
            const childPath = path ? `${path}/${childName}` : childName;
            walkNodes(child, visitor, childPath);
        }
    }

    function buildSceneTree(node, path, options, depth) {
        const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 99;
        const keyword = String(options.nameKeyword || '').trim().toLowerCase();
        const current = {
            name: getNodeName(node),
            uuid: getNodeUuid(node),
            active: isNodeActive(node),
            path,
            children: []
        };
        if (depth >= maxDepth) {
            return current;
        }
        for (const child of getChildren(node)) {
            const childName = getNodeName(child);
            const childPath = path ? `${path}/${childName}` : childName;
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
            walkNodes(child, (node, path) => nodes.push({ node, path }), getNodeName(child));
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
            || nodes.find((item) => item.node && getNodeName(item.node) === query)
            || null;
    }

    function findNodes(args) {
        const query = String(args.query || args.node || '').trim();
        const lower = query.toLowerCase();
        const nodes = collectNodes();
        if (!query) {
            return [];
        }
        const exact = nodes.filter((item) => getNodeUuid(item.node) === query || item.path === query || getNodeName(item.node) === query);
        const source = exact.length ? exact : nodes.filter((item) => {
            return getNodeUuid(item.node).toLowerCase().includes(lower)
                || item.path.toLowerCase().includes(lower)
                || getNodeName(item.node).toLowerCase().includes(lower);
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

    function safeValue(value, depth, seen, options) {
        options = options || {};
        const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 2;
        const maxArrayLength = Number.isFinite(Number(options.maxArrayLength)) ? Number(options.maxArrayLength) : 20;
        const includePrivate = !!options.includePrivate;
        if (value === null || value === undefined) {
            return value;
        }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'function') {
            return undefined;
        }
        if (depth > maxDepth) {
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
            return value.slice(0, maxArrayLength).map((item) => safeValue(item, depth + 1, seen, options)).filter((item) => item !== undefined);
        }
        const result = {};
        for (const key of Object.keys(value).slice(0, 40)) {
            if (!includePrivate && key.startsWith('_')) {
                continue;
            }
            try {
                const child = safeValue(value[key], depth + 1, seen, options);
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

    function findComponent(args) {
        const found = findNode(args.node || args.query || args.path || args.uuid);
        if (!found) {
            return { error: `未找到节点：${args.node || args.query || args.path || args.uuid || ''}` };
        }
        const componentName = String(args.component || args.componentType || '').trim();
        const components = getComponents(found.node);
        if (!componentName && components.length === 1) {
            return { found, component: components[0], components };
        }
        const component = components.find((item) => {
            const type = getComponentType(item);
            const uuid = getComponentUuid(item);
            return uuid === componentName
                || type === componentName
                || type.endsWith(componentName)
                || type.split('.').pop() === componentName;
        });
        if (!component) {
            return {
                found,
                components,
                error: `节点 ${found.path} 上未找到组件：${componentName || '(未指定)'}。可用组件：${components.map(getComponentType).join(', ')}`
            };
        }
        return { found, component, components };
    }

    function componentMatches(component, componentName) {
        const query = String(componentName || '').trim();
        if (!component || !query) {
            return false;
        }
        const type = getComponentType(component);
        const uuid = getComponentUuid(component);
        const shortType = type.split('.').pop();
        return uuid === query
            || type === query
            || type.endsWith(query)
            || shortType === query;
    }

    function findNodesByComponent(args) {
        const componentName = String(args.component || args.componentType || '').trim();
        if (!componentName) {
            return { success: false, error: '缺少要查询的组件名 component。' };
        }
        const nodes = collectNodes();
        const matched = [];
        for (const item of nodes) {
            const components = getComponents(item.node).filter((component) => componentMatches(component, componentName));
            if (!components.length) {
                continue;
            }
            matched.push({
                name: getNodeName(item.node),
                uuid: getNodeUuid(item.node),
                path: item.path,
                active: isNodeActive(item.node),
                components: components.map(componentSummary)
            });
        }
        return {
            success: true,
            data: {
                component: componentName,
                total: matched.length,
                nodes: matched
            }
        };
    }

    function listComponentMethods(component, allowPrivate) {
        const names = new Set();
        let cursor = component;
        while (cursor && cursor !== Object.prototype) {
            for (const key of Object.getOwnPropertyNames(cursor)) {
                if (key === 'constructor') {
                    continue;
                }
                if (!allowPrivate && key.startsWith('_')) {
                    continue;
                }
                try {
                    if (typeof component[key] === 'function') {
                        names.add(key);
                    }
                } catch (_) {
                }
            }
            cursor = Object.getPrototypeOf(cursor);
        }
        return Array.from(names).sort().slice(0, 80);
    }

    function componentDetail(args) {
        const target = findComponent(args);
        if (target.error) {
            return { success: false, error: target.error };
        }
        const options = {
            maxDepth: Number(args.maxDepth) || 2,
            maxArrayLength: Number(args.maxArrayLength) || 20,
            includePrivate: !!args.includePrivate
        };
        const props = Array.isArray(args.props) ? args.props.map(String).filter(Boolean) : [];
        const properties = {};
        if (props.length) {
            for (const prop of props) {
                try {
                    properties[prop] = safeValue(target.component[prop], 0, new WeakSet(), options);
                } catch (error) {
                    properties[prop] = `[读取失败：${error && error.message ? error.message : String(error)}]`;
                }
            }
        } else {
            Object.assign(properties, safeValue(target.component, 0, new WeakSet(), options));
        }
        return {
            success: true,
            data: {
                node: target.found.path,
                component: componentSummary(target.component),
                methods: listComponentMethods(target.component, !!args.includePrivate),
                properties
            }
        };
    }

    function parsePropertyPath(rawPath) {
        const path = String(rawPath || '').trim();
        const tokens = [];
        let buffer = '';
        let bracket = '';
        let inBracket = false;
        let quote = '';
        function pushToken(value) {
            const token = String(value || '').trim();
            if (!token) {
                return;
            }
            tokens.push(/^\d+$/.test(token) ? Number(token) : token);
        }
        for (let i = 0; i < path.length; i += 1) {
            const char = path[i];
            if (inBracket) {
                if (quote) {
                    if (char === quote) {
                        quote = '';
                    } else {
                        bracket += char;
                    }
                    continue;
                }
                if (char === '"' || char === "'") {
                    quote = char;
                    continue;
                }
                if (char === ']') {
                    pushToken(bracket);
                    bracket = '';
                    inBracket = false;
                    continue;
                }
                bracket += char;
                continue;
            }
            if (char === '.') {
                pushToken(buffer);
                buffer = '';
                continue;
            }
            if (char === '[') {
                pushToken(buffer);
                buffer = '';
                inBracket = true;
                bracket = '';
                continue;
            }
            buffer += char;
        }
        pushToken(buffer);
        return tokens;
    }

    function resolvePropertyPath(root, tokens, options) {
        let current = root;
        const traversed = [];
        for (const token of tokens) {
            traversed.push(String(token));
            if (!options.includePrivate && String(token).startsWith('_')) {
                return {
                    exists: false,
                    error: `默认不允许读取私有属性路径：${traversed.join('.')}`
                };
            }
            if (current === null || current === undefined || !(token in Object(current))) {
                return {
                    exists: false,
                    failedAt: traversed.join('.')
                };
            }
            current = current[token];
        }
        return { exists: true, value: current };
    }

    function getPropertyPath(args) {
        const propertyPath = String(args.propertyPath || args.propPath || (args.component || args.componentType ? args.path : '') || '').trim();
        if (!propertyPath) {
            return { success: false, error: '缺少要读取的属性路径 propertyPath。' };
        }
        const options = {
            maxDepth: Number(args.maxDepth) || 2,
            maxArrayLength: Number(args.maxArrayLength) || 20,
            includePrivate: !!args.includePrivate
        };
        const tokens = parsePropertyPath(propertyPath);
        if (!tokens.length) {
            return { success: false, error: `属性路径无效：${propertyPath}` };
        }

        let nodeInfo = null;
        let targetInfo = null;
        let root = null;
        let rootType = '';
        if (args.component || args.componentType) {
            const target = findComponent(args);
            if (target.error) {
                return { success: false, error: target.error };
            }
            nodeInfo = target.found;
            targetInfo = componentSummary(target.component);
            root = target.component;
            rootType = 'component';
        } else {
            const found = findNode(args.node || args.query || args.uuid);
            if (!found) {
                return { success: false, error: `未找到节点：${args.node || args.query || args.uuid || ''}` };
            }
            nodeInfo = found;
            root = found.node;
            rootType = 'node';
            if (tokens[0] === 'node') {
                tokens.shift();
            }
        }

        const resolved = resolvePropertyPath(root, tokens, options);
        if (!resolved.exists) {
            return {
                success: false,
                error: resolved.error || `属性路径不存在：${propertyPath}${resolved.failedAt ? `，失败位置：${resolved.failedAt}` : ''}`,
                data: {
                    node: nodeInfo.path,
                    target: rootType,
                    component: targetInfo,
                    propertyPath
                }
            };
        }
        return {
            success: true,
            data: {
                node: nodeInfo.path,
                target: rootType,
                component: targetInfo,
                propertyPath,
                value: safeValue(resolved.value, 0, new WeakSet(), options)
            }
        };
    }

    async function callComponentMethod(args) {
        const target = findComponent(args);
        if (target.error) {
            return { success: false, error: target.error };
        }
        const method = String(args.method || '').trim();
        if (!method) {
            return { success: false, error: '缺少要调用的方法名 method。' };
        }
        if (!args.allowPrivateMethod && method.startsWith('_')) {
            return { success: false, error: `默认不允许调用私有方法：${method}` };
        }
        const fn = target.component[method];
        if (typeof fn !== 'function') {
            return {
                success: false,
                error: `组件 ${getComponentType(target.component)} 上不存在可调用方法：${method}`,
                data: {
                    methods: listComponentMethods(target.component, !!args.allowPrivateMethod)
                }
            };
        }
        const methodArgs = Array.isArray(args.args) ? args.args : [];
        try {
            const value = await fn.apply(target.component, methodArgs);
            return {
                success: true,
                message: `已调用运行态方法：${getComponentType(target.component)}.${method}()`,
                data: {
                    node: target.found.path,
                    component: componentSummary(target.component),
                    method,
                    args: methodArgs,
                    result: safeValue(value, 0, new WeakSet(), {
                        maxDepth: Number(args.maxDepth) || 2,
                        maxArrayLength: Number(args.maxArrayLength) || 20,
                        includePrivate: !!args.includePrivate
                    })
                }
            };
        } catch (error) {
            return {
                success: false,
                error: `调用运行态方法失败：${error && error.message ? error.message : String(error)}`,
                data: {
                    node: target.found.path,
                    component: componentSummary(target.component),
                    method
                }
            };
        }
    }

    function filterConsoleLogs(args) {
        const logType = String(args.logType || 'all').toLowerCase();
        const keyword = String(args.keyword || '').toLowerCase();
        const sinceIndex = Number(args.sinceIndex) || 0;
        const limit = Math.max(1, Math.min(Number(args.limit) || 100, CONSOLE_LOG_LIMIT));
        let logs = consoleLogs.slice();
        if (sinceIndex > 0) {
            logs = logs.filter((item) => Number(item.index) > sinceIndex);
        }
        if (logType && logType !== 'all') {
            logs = logs.filter((item) => item.level === logType);
        }
        if (keyword) {
            logs = logs.filter((item) => String(item.text || '').toLowerCase().includes(keyword));
        }
        return logs.slice(-limit);
    }

    async function getConsoleLogs(args) {
        const waitMs = Math.max(0, Math.min(Number(args.waitMs) || 0, 10000));
        const intervalMs = Math.max(20, Math.min(Number(args.intervalMs) || 100, 1000));
        const startedAt = Date.now();
        let logs = filterConsoleLogs(args);
        while (!logs.length && waitMs > 0 && Date.now() - startedAt < waitMs) {
            await sleep(intervalMs);
            logs = filterConsoleLogs(args);
        }
        const result = {
            success: true,
            data: {
                totalStored: consoleLogs.length,
                returned: logs.length,
                waitedMs: Date.now() - startedAt,
                logs
            }
        };
        if (args.clear) {
            consoleLogs.length = 0;
        }
        return result;
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

    function vec3From(value, fallback) {
        fallback = fallback || { x: 0, y: 0, z: 0 };
        return {
            x: Number(value && value.x !== undefined ? value.x : fallback.x) || 0,
            y: Number(value && value.y !== undefined ? value.y : fallback.y) || 0,
            z: Number(value && value.z !== undefined ? value.z : fallback.z) || 0
        };
    }

    function addVec3(left, right) {
        return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
    }

    function scaleVec3(value, scale) {
        return { x: value.x * scale, y: value.y * scale, z: value.z * scale };
    }

    function normalizeVec3(value) {
        const length = Math.sqrt(value.x * value.x + value.y * value.y + value.z * value.z);
        return length ? { x: value.x / length, y: value.y / length, z: value.z / length } : { x: 0, y: 0, z: -1 };
    }

    function readComponentValue(component, publicName, privateName, fallback) {
        try {
            if (component && component[publicName] !== undefined) {
                return component[publicName];
            }
        } catch (_) {}
        try {
            if (component && component[privateName] !== undefined) {
                return component[privateName];
            }
        } catch (_) {}
        return fallback;
    }

    function getCameras() {
        const cameras = [];
        for (const item of collectNodes()) {
            for (const component of getComponents(item.node)) {
                const type = getComponentType(component);
                if (/Camera$/i.test(type) || type === 'cc.Camera') {
                    cameras.push({ node: item.node, path: item.path, component });
                }
            }
        }
        return cameras;
    }

    function createCcVec3(value) {
        const cc = getCc();
        if (cc && typeof cc.v3 === 'function') {
            return cc.v3(value.x, value.y, value.z);
        }
        if (cc && cc.Vec3) {
            try {
                return new cc.Vec3(value.x, value.y, value.z);
            } catch (_) {}
        }
        return value;
    }

    function ensureDebugCanvas() {
        let canvas = debugDrawState.canvas;
        if (!canvas || !canvas.parentNode) {
            canvas = document.createElement('canvas');
            canvas.id = 'cocos-mcp-physics-debug-overlay';
            canvas.style.position = 'fixed';
            canvas.style.left = '0';
            canvas.style.top = '0';
            canvas.style.width = '100vw';
            canvas.style.height = '100vh';
            canvas.style.pointerEvents = 'none';
            canvas.style.zIndex = '2147483647';
            document.documentElement.appendChild(canvas);
            debugDrawState.canvas = canvas;
            debugDrawState.context = canvas.getContext('2d');
        }
        resizeDebugCanvas();
        return canvas;
    }

    function resizeDebugCanvas() {
        const canvas = debugDrawState.canvas;
        if (!canvas) {
            return;
        }
        const width = Math.max(1, Math.floor(window.innerWidth || document.documentElement.clientWidth || 1));
        const height = Math.max(1, Math.floor(window.innerHeight || document.documentElement.clientHeight || 1));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
    }

    function applyDebugVisibility() {
        if (debugDrawState.canvas) {
            debugDrawState.canvas.style.display = debugDrawState.enabled ? 'block' : 'none';
        }
        if (debugDrawState.panel) {
            debugDrawState.panel.style.display = debugDrawState.panelVisible ? 'block' : 'none';
        }
    }

    function updateDebugPanel() {
        const panel = debugDrawState.panel;
        if (!panel) {
            return;
        }
        const rays = panel.querySelector('[data-debug-toggle="rays"]');
        const colliders = panel.querySelector('[data-debug-toggle="colliders"]');
        const enabled = panel.querySelector('[data-debug-toggle="enabled"]');
        const clear = panel.querySelector('[data-debug-clear="1"]');
        if (rays) {
            rays.checked = debugDrawState.visibleRays !== false;
        }
        if (colliders) {
            colliders.checked = debugDrawState.visibleColliders !== false;
        }
        if (enabled) {
            enabled.checked = debugDrawState.enabled !== false;
        }
        if (clear) {
            clear.textContent = debugDrawState.drawings.length
                ? '清除绘制'
                : debugDrawState.stashedDrawings.length
                    ? '恢复绘制'
                    : '清除绘制';
        }
        panel.style.left = `${Math.max(0, Number(debugDrawState.panelX) || 0)}px`;
        panel.style.top = `${Math.max(0, Number(debugDrawState.panelY) || 0)}px`;
        applyDebugVisibility();
    }

    function ensureDebugPanel() {
        let panel = debugDrawState.panel;
        if (panel && panel.parentNode) {
            updateDebugPanel();
            return panel;
        }
        panel = document.createElement('div');
        panel.id = 'cocos-mcp-physics-debug-panel';
        panel.style.position = 'fixed';
        panel.style.left = `${debugDrawState.panelX}px`;
        panel.style.top = `${debugDrawState.panelY}px`;
        panel.style.zIndex = '2147483647';
        panel.style.minWidth = '168px';
        panel.style.padding = '0';
        panel.style.border = '1px solid rgba(0,229,255,0.75)';
        panel.style.background = 'rgba(10,14,18,0.88)';
        panel.style.color = '#e5faff';
        panel.style.font = '12px sans-serif';
        panel.style.boxShadow = '0 6px 18px rgba(0,0,0,0.35)';
        panel.style.pointerEvents = 'auto';
        panel.innerHTML = [
            '<div data-debug-drag="1" style="cursor:move;padding:7px 9px;background:rgba(0,229,255,0.16);font-weight:600;user-select:none;">MCP 物理调试</div>',
            '<label style="display:flex;align-items:center;gap:6px;padding:8px 9px 0;"><input data-debug-toggle="enabled" type="checkbox">启用显示</label>',
            '<label style="display:flex;align-items:center;gap:6px;padding:6px 9px 0;"><input data-debug-toggle="rays" type="checkbox">显示射线</label>',
            '<label style="display:flex;align-items:center;gap:6px;padding:6px 9px 8px;"><input data-debug-toggle="colliders" type="checkbox">显示碰撞体</label>',
            '<button data-debug-clear="1" style="margin:0 9px 8px;padding:3px 8px;border:1px solid #40505a;background:#151f25;color:#e5faff;cursor:pointer;">清除绘制</button>'
        ].join('');
        document.documentElement.appendChild(panel);
        debugDrawState.panel = panel;

        const drag = panel.querySelector('[data-debug-drag="1"]');
        if (drag) {
            drag.addEventListener('mousedown', (event) => {
                event.preventDefault();
                const startX = event.clientX;
                const startY = event.clientY;
                const startLeft = Number(debugDrawState.panelX) || 0;
                const startTop = Number(debugDrawState.panelY) || 0;
                const move = (moveEvent) => {
                    debugDrawState.panelX = Math.max(0, startLeft + moveEvent.clientX - startX);
                    debugDrawState.panelY = Math.max(0, startTop + moveEvent.clientY - startY);
                    updateDebugPanel();
                };
                const up = () => {
                    window.removeEventListener('mousemove', move);
                    window.removeEventListener('mouseup', up);
                };
                window.addEventListener('mousemove', move);
                window.addEventListener('mouseup', up);
            });
        }
        const enabled = panel.querySelector('[data-debug-toggle="enabled"]');
        const rays = panel.querySelector('[data-debug-toggle="rays"]');
        const colliders = panel.querySelector('[data-debug-toggle="colliders"]');
        if (enabled) {
            enabled.addEventListener('change', () => {
                debugDrawState.enabled = !!enabled.checked;
                redrawDebugDrawings();
            });
        }
        if (rays) {
            rays.addEventListener('change', () => {
                debugDrawState.visibleRays = !!rays.checked;
                redrawDebugDrawings();
            });
        }
        if (colliders) {
            colliders.addEventListener('change', () => {
                debugDrawState.visibleColliders = !!colliders.checked;
                redrawDebugDrawings();
            });
        }
        const clear = panel.querySelector('[data-debug-clear="1"]');
        if (clear) {
            clear.addEventListener('click', () => {
                togglePanelDebugDrawings();
            });
        }
        updateDebugPanel();
        return panel;
    }

    function getDebugCanvas() {
        return ensureDebugCanvas();
    }

    function getGameCanvasViewport() {
        const cc = getCc();
        const gameCanvas = cc && cc.game && cc.game.canvas
            || document.querySelector('canvas:not(#cocos-mcp-physics-debug-overlay)')
            || null;
        if (!gameCanvas || typeof gameCanvas.getBoundingClientRect !== 'function') {
            return {
                left: 0,
                top: 0,
                width: window.innerWidth || document.documentElement.clientWidth || 1,
                height: window.innerHeight || document.documentElement.clientHeight || 1,
                logicalWidth: window.innerWidth || document.documentElement.clientWidth || 1,
                logicalHeight: window.innerHeight || document.documentElement.clientHeight || 1
            };
        }
        const rect = gameCanvas.getBoundingClientRect();
        return {
            left: rect.left,
            top: rect.top,
            width: rect.width || gameCanvas.clientWidth || gameCanvas.width || 1,
            height: rect.height || gameCanvas.clientHeight || gameCanvas.height || 1,
            logicalWidth: gameCanvas.width || rect.width || 1,
            logicalHeight: gameCanvas.height || rect.height || 1
        };
    }

    function projectWorld(value) {
        const world = vec3From(value);
        const cameras = getCameras();
        const canvas = getDebugCanvas();
        for (const camera of cameras) {
            const component = camera.component;
            if (!component || typeof component.worldToScreen !== 'function') {
                continue;
            }
            try {
                const input = createCcVec3(world);
                let output = null;
                if (component.worldToScreen.length >= 2) {
                    output = createCcVec3({ x: 0, y: 0, z: 0 });
                    component.worldToScreen(input, output);
                }
                else {
                    output = component.worldToScreen(input);
                }
                const screen = toPlainVec(output);
                if (screen && Number.isFinite(screen.x) && Number.isFinite(screen.y)) {
                    const viewport = getGameCanvasViewport();
                    const scaleX = viewport.width / Math.max(1, viewport.logicalWidth);
                    const scaleY = viewport.height / Math.max(1, viewport.logicalHeight);
                    return {
                        x: viewport.left + screen.x * scaleX,
                        y: viewport.top + (viewport.logicalHeight - screen.y) * scaleY,
                        z: Number(screen.z) || 0,
                        camera: camera.path,
                        viewport: {
                            left: viewport.left,
                            top: viewport.top,
                            width: viewport.width,
                            height: viewport.height
                        }
                    };
                }
            } catch (_) {}
        }
        return null;
    }

    function parseColor(value, fallback) {
        if (typeof value === 'string' && value.trim()) {
            return value;
        }
        if (value && typeof value === 'object') {
            const r = Math.max(0, Math.min(255, Number(value.r) || 0));
            const g = Math.max(0, Math.min(255, Number(value.g) || 0));
            const b = Math.max(0, Math.min(255, Number(value.b) || 0));
            const a = value.a === undefined ? 1 : Math.max(0, Math.min(1, Number(value.a) > 1 ? Number(value.a) / 255 : Number(value.a)));
            return `rgba(${r},${g},${b},${a})`;
        }
        return fallback || '#00e5ff';
    }

    function addDebugDrawing(drawing, args) {
        ensureDebugCanvas();
        ensureDebugPanel();
        debugDrawState.stashedDrawings = [];
        const now = Date.now();
        const duration = Number(args && args.duration) || 0;
        const item = Object.assign({}, drawing, {
            id: debugDrawState.nextId++,
            createdAt: now,
            expiresAt: duration > 0 ? now + duration : 0,
            color: parseColor(args && args.color, drawing.color),
            thickness: Math.max(1, Number(args && args.thickness) || Number(drawing.thickness) || 2),
            showLabel: args && args.showLabel !== false
        });
        debugDrawState.drawings.push(item);
        redrawDebugDrawings();
        scheduleDebugRedraw();
        updateDebugPanel();
        return item;
    }

    function pruneDebugDrawings() {
        const now = Date.now();
        debugDrawState.drawings = debugDrawState.drawings.filter((item) => !item.expiresAt || item.expiresAt > now);
    }

    function drawLine(ctx, a, b, color, thickness) {
        const pa = projectWorld(a);
        const pb = projectWorld(b);
        if (!pa || !pb) {
            return false;
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = thickness;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
        return { from: pa, to: pb };
    }

    function drawLabel(ctx, text, world, color) {
        const point = projectWorld(world);
        if (!point || !text) {
            return;
        }
        ctx.font = '12px sans-serif';
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        const width = ctx.measureText(text).width + 8;
        ctx.fillRect(point.x + 5, point.y - 18, width, 18);
        ctx.fillStyle = color;
        ctx.fillText(text, point.x + 9, point.y - 5);
    }

    function drawMarker(ctx, world, color, size) {
        const point = projectWorld(world);
        if (!point) {
            return false;
        }
        const radius = Math.max(4, Number(size) || 8);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(point.x - radius - 4, point.y);
        ctx.lineTo(point.x + radius + 4, point.y);
        ctx.moveTo(point.x, point.y - radius - 4);
        ctx.lineTo(point.x, point.y + radius + 4);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
        ctx.fill();
        return true;
    }

    function drawRayItem(ctx, item) {
        if (item.live && item.sourceArgs) {
            const resolved = resolveRayDrawing(item.sourceArgs);
            if (!resolved.success) {
                return;
            }
            Object.assign(item, resolved.data);
        }
        const lineEnd = item.hit && item.hit.point ? item.hit.point : item.end;
        const lineColor = item.hit && item.hit.point ? (item.hitColor || '#ffcc00') : item.color;
        const projected = drawLine(ctx, item.origin, lineEnd, lineColor, item.thickness);
        if (item.hit && item.hit.point) {
            drawMarker(ctx, item.hit.point, item.hitColor || '#ffcc00', item.hitSize || 8);
            if (item.showLabel) {
                drawLabel(ctx, item.hitLabel || '命中', item.hit.point, item.hitColor || '#ffcc00');
            }
        }
        if (projected && item.showLabel) {
            drawLabel(ctx, item.label || 'ray', item.end, item.color);
        }
    }

    function drawColliderItem(ctx, item) {
        if (item.live) {
            const updated = refreshLiveColliderDrawing(item);
            if (!updated) {
                return;
            }
        }
        for (const edge of item.edges || []) {
            drawLine(ctx, edge[0], edge[1], item.color, item.thickness);
        }
        if (item.showLabel) {
            drawLabel(ctx, item.label || item.node || 'collider', item.labelWorld || item.center || (item.edges && item.edges[0] && item.edges[0][0]), item.color);
        }
    }

    function redrawDebugDrawings() {
        ensureDebugCanvas();
        pruneDebugDrawings();
        const canvas = debugDrawState.canvas;
        const ctx = debugDrawState.context;
        if (!canvas || !ctx) {
            return;
        }
        resizeDebugCanvas();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (debugDrawState.enabled === false) {
            applyDebugVisibility();
            return;
        }
        applyDebugVisibility();
        for (const item of debugDrawState.drawings) {
            if (item.type === 'ray') {
                if (debugDrawState.visibleRays === false) {
                    continue;
                }
                drawRayItem(ctx, item);
            }
            else if (item.type === 'collider') {
                if (debugDrawState.visibleColliders === false) {
                    continue;
                }
                drawColliderItem(ctx, item);
            }
        }
    }

    function scheduleDebugRedraw() {
        if (debugDrawState.raf || !window.requestAnimationFrame) {
            return;
        }
        const tick = function () {
            debugDrawState.raf = 0;
            if (!debugDrawState.drawings.length) {
                return;
            }
            redrawDebugDrawings();
            debugDrawState.raf = window.requestAnimationFrame(tick);
        };
        debugDrawState.raf = window.requestAnimationFrame(tick);
    }

    function transformLocalPoint(node, local) {
        const cc = getCc();
        try {
            if (cc && cc.Vec3 && node && node.worldMatrix && typeof cc.Vec3.transformMat4 === 'function') {
                const out = new cc.Vec3();
                cc.Vec3.transformMat4(out, createCcVec3(local), node.worldMatrix);
                return vec3From(out);
            }
        } catch (_) {}
        const world = readPosition(node) || { x: 0, y: 0, z: 0 };
        const scale = readScale(node) || { x: 1, y: 1, z: 1 };
        return {
            x: world.x + local.x * scale.x,
            y: world.y + local.y * scale.y,
            z: world.z + local.z * scale.z
        };
    }

    function buildBoxEdges(node, center, size) {
        center = vec3From(center);
        size = vec3From(size, { x: 1, y: 1, z: 1 });
        const hx = size.x / 2;
        const hy = size.y / 2;
        const hz = size.z / 2;
        const locals = [
            { x: center.x - hx, y: center.y - hy, z: center.z - hz },
            { x: center.x + hx, y: center.y - hy, z: center.z - hz },
            { x: center.x + hx, y: center.y + hy, z: center.z - hz },
            { x: center.x - hx, y: center.y + hy, z: center.z - hz },
            { x: center.x - hx, y: center.y - hy, z: center.z + hz },
            { x: center.x + hx, y: center.y - hy, z: center.z + hz },
            { x: center.x + hx, y: center.y + hy, z: center.z + hz },
            { x: center.x - hx, y: center.y + hy, z: center.z + hz }
        ];
        const points = locals.map((point) => transformLocalPoint(node, point));
        const pairs = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
        return pairs.map((pair) => [points[pair[0]], points[pair[1]]]);
    }

    function buildWorldBoxEdges(min, max) {
        min = vec3From(min);
        max = vec3From(max, min);
        const points = [
            { x: min.x, y: min.y, z: min.z },
            { x: max.x, y: min.y, z: min.z },
            { x: max.x, y: max.y, z: min.z },
            { x: min.x, y: max.y, z: min.z },
            { x: min.x, y: min.y, z: max.z },
            { x: max.x, y: min.y, z: max.z },
            { x: max.x, y: max.y, z: max.z },
            { x: min.x, y: max.y, z: max.z }
        ];
        const pairs = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
        return pairs.map((pair) => [points[pair[0]], points[pair[1]]]);
    }

    function readBoundsEdges(bounds) {
        if (!bounds || typeof bounds !== 'object') {
            return null;
        }
        const min = toPlainVec(bounds.min || bounds.minimum || bounds.lowerBound || bounds.lower);
        const max = toPlainVec(bounds.max || bounds.maximum || bounds.upperBound || bounds.upper);
        if (min && max) {
            return buildWorldBoxEdges(min, max);
        }
        const center = toPlainVec(bounds.center || bounds._center);
        const half = toPlainVec(bounds.halfExtents || bounds.extents || bounds._halfExtents || bounds._extents);
        if (center && half) {
            return buildWorldBoxEdges(
                { x: center.x - half.x, y: center.y - half.y, z: center.z - half.z },
                { x: center.x + half.x, y: center.y + half.y, z: center.z + half.z }
            );
        }
        return null;
    }

    function readColliderBoundsEdges(component) {
        const keys = ['worldBounds', '_worldBounds', 'bounds', '_bounds', 'aabb', '_aabb', 'boundingBox', '_boundingBox'];
        for (const key of keys) {
            try {
                const edges = readBoundsEdges(component && component[key]);
                if (edges && edges.length) {
                    return edges;
                }
            } catch (_) {}
        }
        try {
            const shape = component && (component.shape || component._shape);
            const edges = readBoundsEdges(shape && (shape.worldBounds || shape._worldBounds || shape.bounds || shape._bounds || shape.aabb || shape._aabb));
            if (edges && edges.length) {
                return edges;
            }
        } catch (_) {}
        return null;
    }

    function buildPolygonEdges(node, center, points) {
        if (!Array.isArray(points) || points.length < 2) {
            return null;
        }
        center = vec3From(center);
        const worldPoints = points
            .map((point) => vec3From(point, null))
            .filter(Boolean)
            .map((point) => transformLocalPoint(node, {
                x: center.x + point.x,
                y: center.y + point.y,
                z: center.z + (point.z || 0)
            }));
        if (worldPoints.length < 2) {
            return null;
        }
        const edges = [];
        for (let i = 0; i < worldPoints.length; i++) {
            edges.push([worldPoints[i], worldPoints[(i + 1) % worldPoints.length]]);
        }
        return edges;
    }

    function buildSphereEdges(node, center, radius) {
        center = vec3From(center);
        radius = Number(radius) || 0.5;
        const edges = [];
        const segments = 24;
        const axes = [['x', 'y'], ['x', 'z'], ['y', 'z']];
        for (const axis of axes) {
            let previous = null;
            for (let i = 0; i <= segments; i++) {
                const angle = Math.PI * 2 * i / segments;
                const local = { x: center.x, y: center.y, z: center.z };
                local[axis[0]] += Math.cos(angle) * radius;
                local[axis[1]] += Math.sin(angle) * radius;
                const world = transformLocalPoint(node, local);
                if (previous) {
                    edges.push([previous, world]);
                }
                previous = world;
            }
        }
        return edges;
    }

    function axisInfo(direction) {
        const index = Number(direction) || 0;
        if (index === 0) {
            return { main: 'x', a: 'y', b: 'z' };
        }
        if (index === 2) {
            return { main: 'z', a: 'x', b: 'y' };
        }
        return { main: 'y', a: 'x', b: 'z' };
    }

    function buildCapsuleEdges(node, center, radius, height, direction) {
        center = vec3From(center);
        radius = Math.max(0.01, Number(radius) || 0.5);
        height = Math.max(0, Number(height) || radius * 2);
        const axis = axisInfo(direction);
        const halfCylinder = height / 2;
        const segments = 24;
        const edges = [];
        const makePoint = (main, a, b) => {
            const local = { x: center.x, y: center.y, z: center.z };
            local[axis.main] += main;
            local[axis.a] += a;
            local[axis.b] += b;
            return transformLocalPoint(node, local);
        };
        const ring = (main) => {
            const points = [];
            for (let i = 0; i < segments; i++) {
                const angle = Math.PI * 2 * i / segments;
                points.push(makePoint(main, Math.cos(angle) * radius, Math.sin(angle) * radius));
            }
            for (let i = 0; i < points.length; i++) {
                edges.push([points[i], points[(i + 1) % points.length]]);
            }
            return points;
        };
        const top = ring(halfCylinder);
        const bottom = ring(-halfCylinder);
        for (const i of [0, 6, 12, 18]) {
            edges.push([top[i], bottom[i]]);
        }
        for (const plane of [axis.a, axis.b]) {
            for (const sign of [-1, 1]) {
                let previous = null;
                for (let i = 0; i <= segments / 2; i++) {
                    const angle = Math.PI * i / (segments / 2);
                    const main = halfCylinder + Math.sin(angle) * radius;
                    const side = Math.cos(angle) * radius * sign;
                    const local = { x: center.x, y: center.y, z: center.z };
                    local[axis.main] += main;
                    local[plane] += side;
                    const world = transformLocalPoint(node, local);
                    if (previous) {
                        edges.push([previous, world]);
                    }
                    previous = world;
                }
                previous = null;
                for (let i = 0; i <= segments / 2; i++) {
                    const angle = Math.PI * i / (segments / 2);
                    const main = -halfCylinder - Math.sin(angle) * radius;
                    const side = Math.cos(angle) * radius * sign;
                    const local = { x: center.x, y: center.y, z: center.z };
                    local[axis.main] += main;
                    local[plane] += side;
                    const world = transformLocalPoint(node, local);
                    if (previous) {
                        edges.push([previous, world]);
                    }
                    previous = world;
                }
            }
        }
        return edges;
    }

    function readMeshFromCollider(component, node) {
        const candidates = [
            component && component.mesh,
            component && component._mesh,
            component && component.sharedMesh,
            component && component._sharedMesh,
            component && component.model && component.model.mesh,
            component && component._model && component._model.mesh
        ];
        try {
            for (const renderer of getComponents(node)) {
                if (componentKind(getComponentType(renderer)) === 'renderer') {
                    candidates.push(renderer.mesh, renderer._mesh, renderer.model && renderer.model.mesh, renderer._model && renderer._model.mesh);
                }
            }
        } catch (_) {}
        return candidates.find((item) => item && typeof item === 'object') || null;
    }

    function readMeshPositions(mesh) {
        const cc = getCc();
        const attrNames = [
            cc && cc.gfx && cc.gfx.AttributeName && cc.gfx.AttributeName.ATTR_POSITION,
            'a_position',
            'position',
            'POSITION'
        ].filter(Boolean);
        if (mesh && typeof mesh.readAttribute === 'function') {
            for (let primitive = 0; primitive < 8; primitive++) {
                for (const attr of attrNames) {
                    try {
                        const positions = mesh.readAttribute(primitive, attr);
                        if (positions && positions.length) {
                            return { primitive, positions };
                        }
                    } catch (_) {}
                }
            }
        }
        for (const key of ['positions', '_positions', 'vertices', '_vertices']) {
            try {
                const positions = mesh && mesh[key];
                if (positions && positions.length) {
                    return { primitive: 0, positions };
                }
            } catch (_) {}
        }
        return null;
    }

    function readMeshIndices(mesh, primitive) {
        if (mesh && typeof mesh.readIndices === 'function') {
            try {
                const indices = mesh.readIndices(primitive || 0);
                if (indices && indices.length) {
                    return Array.from(indices);
                }
            } catch (_) {}
        }
        for (const key of ['indices', '_indices']) {
            try {
                const indices = mesh && mesh[key];
                if (indices && indices.length) {
                    return Array.from(indices);
                }
            } catch (_) {}
        }
        return null;
    }

    function meshPositionAt(positions, index) {
        const value = positions[index];
        if (value && typeof value === 'object') {
            return vec3From(value, null);
        }
        const offset = index * 3;
        if (positions.length >= offset + 3) {
            return {
                x: Number(positions[offset]) || 0,
                y: Number(positions[offset + 1]) || 0,
                z: Number(positions[offset + 2]) || 0
            };
        }
        return null;
    }

    function buildMeshEdges(node, center, component, args) {
        const mesh = readMeshFromCollider(component, node);
        const read = readMeshPositions(mesh);
        if (!read || !read.positions || !read.positions.length) {
            return null;
        }
        center = vec3From(center);
        const requestedMaxEdges = Number(args && (args.meshMaxEdges || args.maxEdges));
        const maxEdges = Math.max(12, Math.min(requestedMaxEdges || 8000, 20000));
        const indices = readMeshIndices(mesh, read.primitive);
        const edgeKeys = new Set();
        const edges = [];
        const addEdge = (a, b) => {
            if (a === b || a < 0 || b < 0) {
                return;
            }
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            if (edgeKeys.has(key) || edges.length >= maxEdges) {
                return;
            }
            const pa = meshPositionAt(read.positions, a);
            const pb = meshPositionAt(read.positions, b);
            if (!pa || !pb) {
                return;
            }
            edgeKeys.add(key);
            edges.push([
                transformLocalPoint(node, { x: pa.x + center.x, y: pa.y + center.y, z: pa.z + center.z }),
                transformLocalPoint(node, { x: pb.x + center.x, y: pb.y + center.y, z: pb.z + center.z })
            ]);
        };
        if (indices && indices.length >= 3) {
            for (let i = 0; i + 2 < indices.length && edges.length < maxEdges; i += 3) {
                addEdge(indices[i], indices[i + 1]);
                addEdge(indices[i + 1], indices[i + 2]);
                addEdge(indices[i + 2], indices[i]);
            }
        }
        else {
            const vertexCount = Math.floor(read.positions.length / 3);
            for (let i = 0; i + 2 < vertexCount && edges.length < maxEdges; i += 3) {
                addEdge(i, i + 1);
                addEdge(i + 1, i + 2);
                addEdge(i + 2, i);
            }
        }
        if (edges.length) {
            edges.meshInfo = {
                edgeCount: edges.length,
                maxEdges,
                truncated: edgeKeys.size >= maxEdges,
                vertexCount: Math.floor(read.positions.length / 3),
                indexCount: indices ? indices.length : 0
            };
        }
        return edges.length ? edges : null;
    }

    function buildColliderDrawing(item, component, args) {
        const type = getComponentType(component);
        const center = readComponentValue(component, 'center', '_center', { x: 0, y: 0, z: 0 });
        let edges = [];
        let shapeSource = '';
        if (/MeshCollider/i.test(type)) {
            edges = buildMeshEdges(item.node, center, component, args) || [];
            shapeSource = edges.length ? 'mesh' : '';
        }
        const meshInfo = edges && edges.meshInfo || null;
        if (!edges.length && /CapsuleCollider/i.test(type)) {
            const radius = readComponentValue(component, 'radius', '_radius', 0.5);
            const height = readComponentValue(component, 'cylinderHeight', '_cylinderHeight', readComponentValue(component, 'height', '_height', radius * 2));
            const direction = readComponentValue(component, 'direction', '_direction', 1);
            edges = buildCapsuleEdges(item.node, center, radius, height, direction);
            shapeSource = 'capsule';
        }
        if (!edges.length && (/SphereCollider/i.test(type) || /CircleCollider/i.test(type))) {
            edges = buildSphereEdges(item.node, center, readComponentValue(component, 'radius', '_radius', 0.5));
            shapeSource = 'sphere';
        }
        if (!edges.length) {
            const size = readComponentValue(component, 'size', '_size', null);
            if (size) {
                edges = buildBoxEdges(item.node, center, size);
                shapeSource = 'box';
            }
        }
        if (!edges.length) {
            const polygonEdges = buildPolygonEdges(item.node, center, readComponentValue(component, 'points', '_points', null));
            if (polygonEdges && polygonEdges.length) {
                edges = polygonEdges;
                shapeSource = 'polygon';
            }
        }
        if (!edges.length) {
            const boundsEdges = readColliderBoundsEdges(component);
            if (boundsEdges && boundsEdges.length) {
                edges = boundsEdges;
                shapeSource = 'bounds';
            }
        }
        if (!edges.length) {
            const radius = Number(readComponentValue(component, 'radius', '_radius', 0.5)) || 0.5;
            const height = Number(readComponentValue(component, 'cylinderHeight', '_cylinderHeight', readComponentValue(component, 'height', '_height', radius * 2))) || radius * 2;
            edges = buildBoxEdges(item.node, center, { x: radius * 2, y: height, z: radius * 2 });
            shapeSource = 'fallbackBox';
        }
        const isTrigger = !!readComponentValue(component, 'isTrigger', '_isTrigger', false);
        const worldCenter = transformLocalPoint(item.node, vec3From(center));
        return {
            type: 'collider',
            node: item.path,
            nodeRef: getNodeUuid(item.node) || item.path,
            componentRef: getComponentUuid(component) || type,
            componentType: type,
            shapeSource,
            meshInfo,
            center: worldCenter,
            labelWorld: worldCenter,
            label: args && args.showLabel === false ? '' : `${item.path} ${type.split('.').pop()}`,
            color: isTrigger ? '#ffcc00' : '#00e5ff',
            edges
        };
    }

    function refreshLiveColliderDrawing(item) {
        const found = findNode(item.nodeRef || item.node || item.path);
        if (!found) {
            return false;
        }
        const component = getComponents(found.node).find((candidate) => {
            const type = getComponentType(candidate);
            const uuid = getComponentUuid(candidate);
            return uuid === item.componentRef
                || type === item.componentType
                || type.endsWith(String(item.componentType || ''));
        });
        if (!component) {
            return false;
        }
        const updated = buildColliderDrawing(found, component, item.sourceArgs || item);
        Object.assign(item, updated, {
            id: item.id,
            createdAt: item.createdAt,
            expiresAt: item.expiresAt,
            color: item.color,
            thickness: item.thickness,
            showLabel: item.showLabel,
            live: true,
            sourceArgs: item.sourceArgs
        });
        return true;
    }

    function createRay(origin, direction) {
        const cc = getCc();
        const geometry = cc && (cc.geometry || cc.geomUtils || cc.geom);
        const rayCtor = geometry && (geometry.Ray || geometry.ray);
        const ccOrigin = createCcVec3(origin);
        const ccDirection = createCcVec3(direction);
        try {
            if (rayCtor && typeof rayCtor.create === 'function') {
                return rayCtor.create(origin.x, origin.y, origin.z, direction.x, direction.y, direction.z);
            }
        } catch (_) {}
        try {
            if (typeof rayCtor === 'function') {
                return new rayCtor(origin.x, origin.y, origin.z, direction.x, direction.y, direction.z);
            }
        } catch (_) {}
        return {
            o: ccOrigin,
            d: ccDirection,
            origin: ccOrigin,
            direction: ccDirection
        };
    }

    function getPhysicsSystem() {
        const cc = getCc();
        return cc && (cc.PhysicsSystem && (cc.PhysicsSystem.instance || cc.PhysicsSystem.INSTANCE)
            || cc.physics && cc.physics.PhysicsSystem && cc.physics.PhysicsSystem.instance
            || null);
    }

    function rayHitNodeName(result) {
        const collider = result && (result.collider || result.shape || result.hitCollider);
        const node = collider && (collider.node || collider._node);
        return getNodeName(node) || '';
    }

    function simplifyRaycastResult(result) {
        if (!result) {
            return null;
        }
        const point = vec3From(result.hitPoint || result.point || result.worldPoint || result.position || result._hitPoint);
        if (!point) {
            return null;
        }
        return {
            point,
            normal: vec3From(result.hitNormal || result.normal || result._hitNormal, null),
            distance: Number(result.distance || result.hitDistance || result._distance || 0) || 0,
            node: rayHitNodeName(result),
            collider: result.collider ? getComponentType(result.collider) : ''
        };
    }

    function physicsRaycastClosest(origin, direction, maxDistance, args) {
        const system = getPhysicsSystem();
        if (!system) {
            return {
                supported: false,
                hit: false,
                error: '当前运行态没有可用的 PhysicsSystem。'
            };
        }
        const ray = createRay(origin, direction);
        const mask = args && args.mask !== undefined ? args.mask : 0xffffffff;
        const queryTrigger = args && args.queryTrigger !== undefined ? !!args.queryTrigger : true;
        try {
            let hasHit = false;
            if (typeof system.raycastClosest === 'function') {
                hasHit = !!system.raycastClosest(ray, mask, maxDistance, queryTrigger);
            }
            else if (typeof system.raycast === 'function') {
                hasHit = !!system.raycast(ray, mask, maxDistance, queryTrigger);
            }
            else {
                return {
                    supported: false,
                    hit: false,
                    error: 'PhysicsSystem 上没有可用的 raycast 方法。'
                };
            }
            const raw = system.raycastClosestResult
                || (Array.isArray(system.raycastResults) && system.raycastResults[0])
                || null;
            const hit = hasHit ? simplifyRaycastResult(raw) : null;
            return {
                supported: true,
                hit: !!hit,
                result: hit
            };
        } catch (error) {
            return {
                supported: false,
                hit: false,
                error: error && error.message ? error.message : String(error)
            };
        }
    }

    function distanceVec3(a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    function colliderCenterWorld(found) {
        if (!found || !found.node) {
            return null;
        }
        const collider = getComponents(found.node).find((component) => /Collider/i.test(getComponentType(component)));
        if (!collider) {
            return null;
        }
        const center = readComponentValue(collider, 'center', '_center', { x: 0, y: 0, z: 0 });
        return transformLocalPoint(found.node, vec3From(center));
    }

    function rayPointFromNode(ref, offset) {
        const found = findNode(ref);
        if (!found) {
            return null;
        }
        const base = colliderCenterWorld(found) || readPosition(found.node) || { x: 0, y: 0, z: 0 };
        return addVec3(base, vec3From(offset, { x: 0, y: 0, z: 0 }));
    }

    function debugDrawRay(args) {
        const resolved = resolveRayDrawing(args);
        if (!resolved.success) {
            return resolved;
        }
        const item = addDebugDrawing(Object.assign({
            type: 'ray',
            color: '#ff3355',
            live: !!args.live,
            sourceArgs: args.live ? Object.assign({}, args) : null
        }, resolved.data), args);
        return {
            success: true,
            message: args.live ? '已绘制实时运行态调试射线。' : '已绘制运行态调试射线。',
            data: {
                id: item.id,
                live: !!item.live,
                origin: item.origin,
                direction: item.direction,
                end: item.end,
                maxDistance: item.maxDistance,
                raycast: item.raycast,
                hit: !!item.hit,
                label: item.label,
                hitLabel: item.hitLabel,
                hitInfo: item.hitInfo,
                totalDrawings: debugDrawState.drawings.length
            }
        };
    }

    function resolveRayDrawing(args) {
        const originRef = args.originNode || args.fromNode || args.startNode || '';
        const targetRef = args.targetNode || args.toNode || args.endNode || '';
        const origin = originRef ? rayPointFromNode(originRef, args.originOffset) : vec3From(args.origin);
        const target = targetRef ? rayPointFromNode(targetRef, args.targetOffset) : (args.target ? vec3From(args.target) : null);
        if (!origin) {
            return { success: false, error: '缺少射线起点：请提供 origin 或 originNode。' };
        }
        if (targetRef && !target) {
            return { success: false, error: `未找到射线目标节点：${targetRef}` };
        }
        const direction = target
            ? normalizeVec3({ x: target.x - origin.x, y: target.y - origin.y, z: target.z - origin.z })
            : normalizeVec3(vec3From(args.direction, { x: 0, y: 0, z: -1 }));
        const maxDistance = Math.max(0.01, Number(args.maxDistance || args.distance) || (target ? distanceVec3(origin, target) : 10));
        const end = addVec3(origin, scaleVec3(direction, maxDistance));
        const raycast = args.raycast !== false;
        const hitInfo = raycast ? physicsRaycastClosest(origin, direction, maxDistance, args) : { supported: false, hit: false };
        const hit = hitInfo && hitInfo.hit && hitInfo.result ? hitInfo.result : null;
        const badLabel = (value) => /^[?\uFFFD\s]+$/.test(String(value || ''));
        const genericHitLabel = (value) => {
            const text = String(value || '').trim().toLowerCase();
            return text === 'hit' || text === '命中';
        };
        const rayLabel = args.label && !badLabel(args.label)
            ? args.label
            : originRef && targetRef
                ? `射线：${originRef} -> ${targetRef}`
                : hit ? '射线' : '射线：未命中';
        const hitLabel = hit
            ? args.hitLabel && !badLabel(args.hitLabel) && !genericHitLabel(args.hitLabel)
                ? args.hitLabel
                : `命中：${hit.node || hit.collider || '碰撞体'}`
            : '';
        return {
            success: true,
            data: {
                origin,
                direction,
                end,
                maxDistance,
                raycast,
                hit: !!hit,
                hitInfo,
                label: rayLabel,
                hit,
                hitColor: parseColor(args.hitColor, '#ffcc00'),
                hitLabel
            }
        };
    }

    function debugDrawCollider(args) {
        const live = args.live !== false;
        const found = findNode(args.node || args.query || args.path || args.uuid);
        if (!found) {
            return { success: false, error: `未找到节点：${args.node || args.query || args.path || args.uuid || ''}` };
        }
        const componentName = String(args.component || args.componentType || args.colliderType || '').trim();
        const colliders = getComponents(found.node).filter((component) => {
            const type = getComponentType(component);
            return /Collider/i.test(type) && (!componentName || componentMatches(component, componentName));
        });
        if (!colliders.length) {
            return {
                success: false,
                error: `节点 ${found.path} 上没有可绘制的碰撞体组件。`,
                data: { components: getComponents(found.node).map(getComponentType) }
            };
        }
        const drawings = colliders.map((component) => addDebugDrawing(Object.assign(
            buildColliderDrawing(found, component, args),
            { live, sourceArgs: live ? Object.assign({}, args) : null }
        ), args));
        return {
            success: true,
            message: '已绘制节点碰撞体。',
            data: {
                node: found.path,
                live,
                drawn: drawings.length,
                drawingIds: drawings.map((item) => item.id),
                drawings: drawings.map((item) => ({
                    id: item.id,
                    node: item.node,
                    componentType: item.componentType,
                    shapeSource: item.shapeSource,
                    meshInfo: item.meshInfo || null,
                    live: !!item.live
                })),
                colliders: colliders.map(componentSummary),
                totalDrawings: debugDrawState.drawings.length
            }
        };
    }

    function debugDrawAllColliders(args) {
        const live = args.live !== false;
        const maxCount = Math.max(1, Math.min(Number(args.maxCount || args.maxNodes) || 200, 1000));
        const includeInactive = !!args.includeInactive;
        const rootRef = args.rootNode || '';
        let nodes = collectNodes();
        if (rootRef) {
            const root = findNode(rootRef);
            if (!root) {
                return { success: false, error: `未找到根节点：${rootRef}` };
            }
            const collected = [];
            walkNodes(root.node, (node, currentPath) => collected.push({ node, path: currentPath }), root.path);
            nodes = collected;
        }
        const drawings = [];
        let skipped = 0;
        for (const item of nodes) {
            if (!includeInactive && !isNodeActive(item.node)) {
                skipped++;
                continue;
            }
            for (const component of getComponents(item.node)) {
                if (!/Collider/i.test(getComponentType(component))) {
                    continue;
                }
                if (drawings.length >= maxCount) {
                    break;
                }
                drawings.push(addDebugDrawing(Object.assign(
                    buildColliderDrawing(item, component, args),
                    { live, sourceArgs: live ? Object.assign({}, args) : null }
                ), args));
            }
            if (drawings.length >= maxCount) {
                break;
            }
        }
        return {
            success: true,
            message: '已绘制运行场景中的碰撞体。',
            data: {
                drawn: drawings.length,
                live,
                maxCount,
                skipped,
                drawingIds: drawings.map((item) => item.id),
                drawings: drawings.map((item) => ({
                    id: item.id,
                    node: item.node,
                    componentType: item.componentType,
                    shapeSource: item.shapeSource,
                    meshInfo: item.meshInfo || null,
                    live: !!item.live
                })),
                totalDrawings: debugDrawState.drawings.length
            }
        };
    }

    function debugAddCollider(args) {
        const found = findNode(args.node || args.query || args.path || args.uuid);
        if (!found) {
            return { success: false, error: `未找到节点：${args.node || args.query || args.path || args.uuid || ''}` };
        }
        const cc = getCc();
        if (!cc) {
            return { success: false, error: '当前运行态没有可用的 cc。' };
        }
        const colliderType = String(args.colliderType || 'capsule').toLowerCase();
        const ctor = colliderType === 'box'
            ? cc.BoxCollider
            : colliderType === 'sphere'
                ? cc.SphereCollider
                : cc.CapsuleCollider;
        if (!ctor) {
            return { success: false, error: `当前运行态没有可用的 ${colliderType} 碰撞体类型。` };
        }
        let collider = getComponents(found.node).find((component) => component instanceof ctor || getComponentType(component) === `cc.${ctor.name}`);
        const existing = !!collider;
        try {
            if (!collider) {
                collider = found.node.addComponent(ctor);
            }
            if ('isTrigger' in collider && args.isTrigger !== undefined) {
                collider.isTrigger = !!args.isTrigger;
            }
            if ('center' in collider && args.center) {
                collider.center = createCcVec3(vec3From(args.center));
            }
            if ('radius' in collider && args.radius !== undefined) {
                collider.radius = Number(args.radius) || 0.5;
            }
            if ('cylinderHeight' in collider && (args.height !== undefined || args.cylinderHeight !== undefined)) {
                collider.cylinderHeight = Number(args.cylinderHeight !== undefined ? args.cylinderHeight : args.height) || 2;
            }
            else if ('height' in collider && args.height !== undefined) {
                collider.height = Number(args.height) || 2;
            }
            if ('size' in collider && args.size) {
                collider.size = createCcVec3(vec3From(args.size, { x: 1, y: 1, z: 1 }));
            }
            if ('direction' in collider && args.direction !== undefined) {
                collider.direction = Number(args.direction) || 1;
            }
            if (typeof collider.onEnable === 'function') {
                try { collider.onEnable(); } catch (_) {}
            }
            return {
                success: true,
                message: existing ? '运行态碰撞体已更新。' : '运行态碰撞体已添加。',
                data: {
                    node: found.path,
                    component: componentSummary(collider),
                    existing
                }
            };
        } catch (error) {
            return {
                success: false,
                error: error && error.message ? error.message : String(error)
            };
        }
    }

    function stopDebugRedrawLoop() {
        if (debugDrawState.raf && window.cancelAnimationFrame) {
            window.cancelAnimationFrame(debugDrawState.raf);
        }
        debugDrawState.raf = 0;
    }

    function clearDebugCanvas() {
        if (debugDrawState.context && debugDrawState.canvas) {
            debugDrawState.context.clearRect(0, 0, debugDrawState.canvas.width, debugDrawState.canvas.height);
        }
    }

    function togglePanelDebugDrawings() {
        if (debugDrawState.drawings.length) {
            debugDrawState.stashedDrawings = debugDrawState.drawings;
            debugDrawState.drawings = [];
            stopDebugRedrawLoop();
            clearDebugCanvas();
            updateDebugPanel();
            return;
        }
        if (debugDrawState.stashedDrawings.length) {
            debugDrawState.drawings = debugDrawState.stashedDrawings;
            debugDrawState.stashedDrawings = [];
            redrawDebugDrawings();
            scheduleDebugRedraw();
            updateDebugPanel();
        }
    }

    function debugClearDrawings() {
        debugDrawState.drawings = [];
        debugDrawState.stashedDrawings = [];
        stopDebugRedrawLoop();
        clearDebugCanvas();
        updateDebugPanel();
        return { success: true, message: '已清除运行态物理调试绘制。', data: { totalDrawings: 0 } };
    }

    function debugSetVisibility(args) {
        if (args.enabled !== undefined) {
            debugDrawState.enabled = !!args.enabled;
        }
        if (args.showRays !== undefined || args.rays !== undefined) {
            debugDrawState.visibleRays = args.showRays !== undefined ? !!args.showRays : !!args.rays;
        }
        if (args.showColliders !== undefined || args.colliders !== undefined) {
            debugDrawState.visibleColliders = args.showColliders !== undefined ? !!args.showColliders : !!args.colliders;
        }
        if (args.panelVisible !== undefined || args.panel !== undefined) {
            debugDrawState.panelVisible = args.panelVisible !== undefined ? !!args.panelVisible : !!args.panel;
        }
        ensureDebugCanvas();
        ensureDebugPanel();
        updateDebugPanel();
        redrawDebugDrawings();
        return {
            success: true,
            message: '已更新运行态物理调试显示设置。',
            data: {
                enabled: debugDrawState.enabled !== false,
                showRays: debugDrawState.visibleRays !== false,
                showColliders: debugDrawState.visibleColliders !== false,
                panelVisible: debugDrawState.panelVisible !== false,
                totalDrawings: debugDrawState.drawings.length
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
            if (item.node && isNodeActive(item.node)) {
                activeNodeCount++;
            }
            for (const component of getComponents(item.node)) {
                componentCount++;
                const type = getComponentType(component);
                componentTypes[type] = (componentTypes[type] || 0) + 1;
            }
        }
        const profiler = collectProfilerStats();
        return {
            sceneName: getSceneName(scene),
            sceneIncluded: !!scene,
            sceneRootCount,
            nodeCount,
            activeNodeCount,
            componentCount,
            componentTypes,
            fps: profiler.fps,
            drawCalls: profiler.drawCalls,
            frameTimeMs: profiler.frameTimeMs,
            frameIntervalMs: profiler.frameIntervalMs,
            gameLogicTimeMs: profiler.gameLogicTimeMs,
            physicsTimeMs: profiler.physicsTimeMs,
            rendererTimeMs: profiler.rendererTimeMs,
            presentTimeMs: profiler.presentTimeMs,
            triangles: profiler.triangles,
            instances: profiler.instances,
            gfxTextureMemoryMB: profiler.gfxTextureMemoryMB,
            gfxBufferMemoryMB: profiler.gfxBufferMemoryMB,
            profiler,
            url: location.href
        };
    }

    function stableAssetId(value) {
        if (!value) {
            return '';
        }
        try {
            return String(value.uuid || value._uuid || value._id || value.name || value._name || value._native || '');
        } catch (_) {
            return '';
        }
    }

    function readFirstNumber(source, keys) {
        for (const key of keys) {
            try {
                const value = source && source[key];
                if (typeof value === 'number' && Number.isFinite(value)) {
                    return value;
                }
                if (value && typeof value.value === 'number' && Number.isFinite(value.value)) {
                    return value.value;
                }
                if (value && typeof value.counter === 'number' && Number.isFinite(value.counter)) {
                    return value.counter;
                }
                if (value && value.counter && typeof value.counter.value === 'number' && Number.isFinite(value.counter.value)) {
                    return value.counter.value;
                }
                if (value && value.counter && typeof value.counter._value === 'number' && Number.isFinite(value.counter._value)) {
                    return value.counter._value;
                }
                if (value && value.counter && typeof value.counter._averageValue === 'number' && Number.isFinite(value.counter._averageValue) && value.counter._averageValue > 0) {
                    return value.counter._averageValue;
                }
                if (value && value.counter && typeof value.counter.human === 'function') {
                    const humanValue = value.counter.human();
                    if (typeof humanValue === 'number' && Number.isFinite(humanValue)) {
                        return humanValue;
                    }
                }
            } catch (_) {
            }
        }
        return null;
    }

    function normalizeTimeMs(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return null;
        }
        return value > 0 && value < 1 ? value * 1000 : value;
    }

    function getRenderSceneRoot() {
        const scene = getScene();
        const candidates = [];
        try {
            if (scene && scene._renderScene) {
                candidates.push(scene._renderScene);
            }
        } catch (_) {
        }
        try {
            const cc = getCc();
            const director = getDirector(cc);
            if (director && director._scene && director._scene._renderScene) {
                candidates.push(director._scene._renderScene);
            }
        } catch (_) {
        }
        for (const item of collectNodes()) {
            for (const component of getComponents(item.node)) {
                try {
                    if (component && component._model && component._model.scene) {
                        candidates.push(component._model.scene);
                    }
                } catch (_) {
                }
                try {
                    const models = component && component._models;
                    if (Array.isArray(models)) {
                        for (const model of models) {
                            if (model && model.scene) {
                                candidates.push(model.scene);
                            }
                        }
                    }
                } catch (_) {
                }
            }
        }
        for (const renderScene of candidates) {
            try {
                if (renderScene && renderScene._root) {
                    return renderScene._root;
                }
            } catch (_) {
            }
        }
        return null;
    }

    function getGfxDevice(root) {
        const candidates = [
            root && root._device,
            root && root.device,
            root && root._mainWindow && root._mainWindow._device,
            root && root._pipeline && root._pipeline._device,
            root && root._batcher && (root._batcher.device || root._batcher._device)
        ];
        for (const device of candidates) {
            if (device) {
                return device;
            }
        }
        return null;
    }

    function collectGfxMemory(device) {
        const memory = device && (device._memoryStatus || device.memoryStatus);
        if (!memory || typeof memory !== 'object') {
            return null;
        }
        const result = {};
        for (const [key, value] of Object.entries(memory)) {
            if (typeof value === 'number' && Number.isFinite(value)) {
                result[key] = value;
            } else if (value && typeof value === 'object') {
                const nested = {};
                for (const [childKey, childValue] of Object.entries(value)) {
                    if (typeof childValue === 'number' && Number.isFinite(childValue)) {
                        nested[childKey] = childValue;
                    }
                }
                if (Object.keys(nested).length) {
                    result[key] = nested;
                }
            }
        }
        return Object.keys(result).length ? result : null;
    }

    function collectProfilerStats() {
        const cc = getCc();
        const director = getDirector(cc);
        const profiler = cc && (cc.profiler || cc.Profiler && cc.Profiler.instance) || null;
        const stats = profiler && (profiler._profilerStats || profiler.profilerStats || profiler._stats || profiler.stats || profiler._rootStats) || null;
        const root = getRenderSceneRoot();
        const device = getGfxDevice(root);
        const result = {
            fps: null,
            drawCalls: null,
            frameTimeMs: null,
            frameIntervalMs: null,
            gameLogicTimeMs: null,
            physicsTimeMs: null,
            rendererTimeMs: null,
            presentTimeMs: null,
            instances: null,
            triangles: null,
            gfxMemory: null,
            gfxTextureMemoryMB: null,
            gfxBufferMemoryMB: null,
            renderer: null,
            vendor: null,
            totalFrames: null,
            source: ''
        };
        try {
            if (director && typeof director.getTotalFrames === 'function') {
                result.totalFrames = director.getTotalFrames();
            } else if (director && typeof director._totalFrames === 'number') {
                result.totalFrames = director._totalFrames;
            }
        } catch (_) {
        }
        if (stats) {
            result.fps = readFirstNumber(stats, ['fps', 'FPS', 'frameRate']);
            result.drawCalls = readFirstNumber(stats, ['draws', 'drawCalls', 'drawcall', 'dc']);
            result.frameTimeMs = readFirstNumber(stats, ['frame', 'frameTime', 'frameTimeMs']);
            result.gameLogicTimeMs = readFirstNumber(stats, ['gameLogic', 'gameLogicTime', 'logic', 'logicTime']);
            result.physicsTimeMs = readFirstNumber(stats, ['physics', 'physicsTime']);
            result.rendererTimeMs = readFirstNumber(stats, ['renderer', 'rendererTime', 'render', 'renderTime']);
            result.presentTimeMs = readFirstNumber(stats, ['present', 'presentTime']);
            result.instances = readFirstNumber(stats, ['instances', 'instanceCount']);
            result.triangles = readFirstNumber(stats, ['tricount', 'triangles', 'triangleCount']);
            result.gfxTextureMemoryMB = readFirstNumber(stats, ['textureMemory', 'gfxTextureMemory']);
            result.gfxBufferMemoryMB = readFirstNumber(stats, ['bufferMemory', 'gfxBufferMemory']);
            result.source = 'cc.profiler';
        }
        if (root) {
            result.fps = result.fps === null ? readFirstNumber(root, ['_fps', 'fps']) : result.fps;
            result.frameIntervalMs = normalizeTimeMs(readFirstNumber(root, ['_frameTime', 'frameTime']));
            result.frameTimeMs = result.frameTimeMs === null ? result.frameIntervalMs : result.frameTimeMs;
            result.source = result.source || 'renderScene.root';
        }
        if (device) {
            result.drawCalls = result.drawCalls === null ? readFirstNumber(device, ['_numDrawCalls', 'numDrawCalls', 'drawCalls']) : result.drawCalls;
            result.instances = result.instances === null ? readFirstNumber(device, ['_numInstances', 'numInstances', 'instances']) : result.instances;
            result.triangles = result.triangles === null ? readFirstNumber(device, ['_numTris', 'numTris', 'triangles']) : result.triangles;
            result.gfxMemory = collectGfxMemory(device);
            if (result.gfxMemory) {
                result.gfxTextureMemoryMB = result.gfxTextureMemoryMB === null && typeof result.gfxMemory.textureSize === 'number' ? result.gfxMemory.textureSize / (1024 * 1024) : result.gfxTextureMemoryMB;
                result.gfxBufferMemoryMB = result.gfxBufferMemoryMB === null && typeof result.gfxMemory.bufferSize === 'number' ? result.gfxMemory.bufferSize / (1024 * 1024) : result.gfxBufferMemoryMB;
            }
            try {
                result.renderer = device._renderer || device.renderer || null;
                result.vendor = device._vendor || device.vendor || null;
            } catch (_) {
            }
            result.source = result.source ? `${result.source}+gfxDevice` : 'gfxDevice';
        }
        try {
            if (result.fps === null && cc && cc.game && typeof cc.game.frameRate === 'number') {
                result.fps = cc.game.frameRate;
                result.source = result.source || 'cc.game.frameRate';
            }
        } catch (_) {
        }
        return result;
    }

    function componentKind(type) {
        if (/Camera$/i.test(type) || type === 'cc.Camera') {
            return 'camera';
        }
        if (/Light$/i.test(type) || /DirectionalLight|SphereLight|SpotLight|PointLight/i.test(type)) {
            return 'light';
        }
        if (/Particle/i.test(type)) {
            return 'particle';
        }
        if (/RigidBody/i.test(type)) {
            return 'rigidbody';
        }
        if (/Collider/i.test(type)) {
            return 'collider';
        }
        if (/Animation|Animator|Skeleton/i.test(type)) {
            return 'animation';
        }
        if (/MeshRenderer|SkinnedMeshRenderer|ModelRenderer|Sprite|Label|RichText|TiledMap|Graphics/i.test(type)) {
            return 'renderer';
        }
        if (/Widget|Layout|Button|Toggle|Slider|ScrollView|EditBox|ProgressBar|PageView|Mask/i.test(type)) {
            return 'ui';
        }
        return 'script';
    }

    const MATERIAL_PROPERTY_KEYS = [
        'mainColor', 'albedo', 'albedoScale', 'emissive', 'emissiveScale',
        'diffuseColor', 'specularColor', 'tintColor', 'color',
        'roughness', 'metallic', 'alphaThreshold', 'opacity', 'tilingOffset'
    ];
    const MATERIAL_TEXTURE_KEYS = [
        'mainTexture', 'albedoMap', 'diffuseMap', 'normalMap', 'emissiveMap',
        'metallicRoughnessMap', 'occlusionMap', 'specularMap', 'roughnessMap'
    ];

    function shortClassName(value) {
        return String(value && value.constructor && (value.constructor.__classname__ || value.constructor.name) || '');
    }

    function readAssetName(value) {
        return String(value && (value.name || value._name || value._native || value._url || value.url) || '');
    }

    function readEffectInfo(material) {
        const candidates = [
            material && material.effectAsset,
            material && material._effectAsset,
            material && material.effect,
            material && material._effect,
            material && material._effectInfo
        ];
        for (const effect of candidates) {
            if (!effect) {
                continue;
            }
            const id = stableAssetId(effect);
            const name = readAssetName(effect) || String(effect.name || effect._name || effect._uuid || '');
            if (id || name) {
                return {
                    id,
                    name,
                    type: shortClassName(effect)
                };
            }
        }
        return {
            id: '',
            name: String(material && (material.effectName || material._effectName || material.shaderName || material._shaderName) || ''),
            type: ''
        };
    }

    function readTextureSummary(value) {
        if (!value || typeof value !== 'object') {
            return null;
        }
        const id = stableAssetId(value);
        const name = readAssetName(value);
        const width = Number(value.width || value._width || value._texture && value._texture.width) || null;
        const height = Number(value.height || value._height || value._texture && value._texture.height) || null;
        if (!id && !name && !width && !height) {
            return null;
        }
        return {
            id,
            name,
            type: shortClassName(value),
            width,
            height
        };
    }

    function readMaterialProperty(material, key) {
        try {
            if (material && typeof material.getProperty === 'function') {
                const value = material.getProperty(key);
                if (value !== undefined) {
                    return value;
                }
            }
        } catch (_) {
        }
        for (const sourceKey of ['_props', '_properties', 'properties']) {
            try {
                const source = material && material[sourceKey];
                if (source && source[key] !== undefined) {
                    return source[key];
                }
            } catch (_) {
            }
        }
        try {
            if (material && material[key] !== undefined) {
                return material[key];
            }
        } catch (_) {
        }
        return undefined;
    }

    function readMaterialProperties(material, options) {
        if (options && options.includeProperties === false) {
            return {};
        }
        const props = {};
        const keys = new Set(MATERIAL_PROPERTY_KEYS);
        if (Array.isArray(options && options.props)) {
            for (const key of options.props) {
                keys.add(key);
            }
        }
        for (const key of keys) {
            const value = readMaterialProperty(material, key);
            if (value !== undefined && value !== null) {
                props[key] = safeValue(value, 0, new WeakSet(), { maxDepth: 1, maxArrayLength: 8 });
            }
        }
        return props;
    }

    function readMaterialTextures(material, options) {
        if (options && options.includeTextures === false) {
            return {};
        }
        const textures = {};
        const keys = new Set(MATERIAL_TEXTURE_KEYS);
        if (Array.isArray(options && options.textureProps)) {
            for (const key of options.textureProps) {
                keys.add(key);
            }
        }
        for (const key of keys) {
            const value = readMaterialProperty(material, key);
            const texture = readTextureSummary(value);
            if (texture) {
                textures[key] = texture;
            }
        }
        return textures;
    }

    function readPassDefines(pass) {
        const defines = {};
        for (const key of ['defines', '_defines', '_macroPatches', 'macroPatches']) {
            try {
                const value = pass && pass[key];
                if (!value) {
                    continue;
                }
                if (Array.isArray(value)) {
                    defines[key] = value.slice(0, 20).map((item) => safeValue(item, 0, new WeakSet(), { maxDepth: 1, maxArrayLength: 8 }));
                } else if (typeof value === 'object') {
                    for (const [defineKey, defineValue] of Object.entries(value).slice(0, 40)) {
                        defines[defineKey] = safeValue(defineValue, 0, new WeakSet(), { maxDepth: 1, maxArrayLength: 8 });
                    }
                }
            } catch (_) {
            }
        }
        return defines;
    }

    function readMaterialPasses(material, options) {
        if (!(options && options.includePasses)) {
            return [];
        }
        const passes = [];
        const candidates = [];
        for (const key of ['passes', '_passes']) {
            try {
                const value = material && material[key];
                if (Array.isArray(value)) {
                    candidates.push(...value);
                }
            } catch (_) {
            }
        }
        return candidates.slice(0, 8).map((pass, index) => ({
            index,
            type: shortClassName(pass),
            phase: String(pass && (pass.phase || pass._phase || '') || ''),
            program: String(pass && (pass.program || pass._program || pass._programName || '') || ''),
            defines: readPassDefines(pass)
        }));
    }

    function readMaterialSummary(material, slot, options) {
        const id = stableAssetId(material) || `material:${slot}`;
        const effect = readEffectInfo(material);
        const properties = readMaterialProperties(material, options || {});
        const textures = readMaterialTextures(material, options || {});
        return {
            slot,
            id,
            uuid: String(material && (material.uuid || material._uuid || '') || id),
            name: readAssetName(material),
            type: shortClassName(material),
            effect,
            shaderName: effect.name,
            properties,
            textures,
            passes: readMaterialPasses(material, options || {})
        };
    }

    function readMaterials(component, options) {
        const candidates = [];
        for (const key of ['materials', '_materials', 'sharedMaterials', '_sharedMaterials']) {
            try {
                const value = component && component[key];
                if (Array.isArray(value)) {
                    candidates.push(...value);
                } else if (value) {
                    candidates.push(value);
                }
            } catch (_) {
            }
        }
        try {
            if (component && typeof component.getSharedMaterial === 'function') {
                const material = component.getSharedMaterial(0);
                if (material) {
                    candidates.push(material);
                }
            }
        } catch (_) {
        }
        try {
            if (candidates.length === 0 && component && typeof component.getMaterial === 'function') {
                const material = component.getMaterial(0);
                if (material) {
                    candidates.push(material);
                }
            }
        } catch (_) {
        }
        const map = new Map();
        candidates.forEach((material, slot) => {
            const id = stableAssetId(material) || `material:${map.size + 1}`;
            if (!map.has(id)) {
                map.set(id, readMaterialSummary(material, slot, options || {}));
            }
        });
        return Array.from(map.values());
    }

    function readMesh(component) {
        for (const key of ['mesh', '_mesh', 'model', '_model']) {
            try {
                const value = component && component[key];
                const id = stableAssetId(value);
                if (id || value) {
                    return {
                        id: id || key,
                        name: String(value && (value.name || value._name) || ''),
                        type: value && value.constructor && (value.constructor.__classname__ || value.constructor.name) || ''
                    };
                }
            } catch (_) {
            }
        }
        return null;
    }

    function getRendererComponents(node, args) {
        const componentName = String(args && (args.component || args.componentType) || '').trim();
        const renderers = [];
        for (const component of getComponents(node)) {
            const type = getComponentType(component);
            if (componentKind(type) !== 'renderer') {
                continue;
            }
            if (componentName && !componentMatches(component, componentName)) {
                continue;
            }
            renderers.push(component);
        }
        return renderers;
    }

    function buildRendererInfo(found, args) {
        const options = {
            includeProperties: args.includeProperties !== false,
            includeTextures: args.includeTextures !== false,
            includePasses: !!args.includePasses,
            props: Array.isArray(args.props) ? args.props : undefined
        };
        const renderers = getRendererComponents(found.node, args).map((component, index) => {
            const materials = readMaterials(component, options);
            const mesh = readMesh(component);
            return {
                index,
                component: componentSummary(component),
                type: getComponentType(component),
                enabled: typeof component.enabled === 'boolean' ? component.enabled : true,
                mesh,
                materialCount: materials.length,
                materials
            };
        });
        return {
            node: {
                name: getNodeName(found.node),
                uuid: getNodeUuid(found.node),
                path: found.path,
                active: isNodeActive(found.node),
                position: readPosition(found.node),
                rotation: readRotation(found.node),
                scale: readScale(found.node)
            },
            rendererCount: renderers.length,
            renderers
        };
    }

    function getRendererInfo(args) {
        const found = findNode(args.node || args.query || args.path || args.uuid);
        if (!found) {
            return { success: false, error: `未找到节点：${args.node || args.query || args.path || args.uuid || ''}` };
        }
        const data = buildRendererInfo(found, args || {});
        if (!data.rendererCount) {
            return {
                success: false,
                error: `节点 ${found.path} 上没有找到 Renderer 组件。`,
                data
            };
        }
        return { success: true, data };
    }

    function normalizeCompareValue(value) {
        if (value === null || value === undefined) {
            return '';
        }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return String(value).toLowerCase();
        }
        if (typeof value === 'object') {
            return JSON.stringify(value).toLowerCase();
        }
        return String(value).toLowerCase();
    }

    function valueMatches(actual, expected, tolerance) {
        if (typeof expected === 'number') {
            const actualNumber = Number(actual);
            return Number.isFinite(actualNumber) && Math.abs(actualNumber - expected) <= tolerance;
        }
        if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
            if (!actual || typeof actual !== 'object') {
                return false;
            }
            return Object.entries(expected).every(([key, value]) => valueMatches(actual[key], value, tolerance));
        }
        const actualText = normalizeCompareValue(actual);
        const expectedText = normalizeCompareValue(expected);
        return actualText === expectedText || actualText.includes(expectedText);
    }

    function pushValidation(checks, name, expected, actual, passed, message) {
        checks.push({ name, expected, actual, passed: !!passed, message });
    }

    function validateMaterialRuntime(args) {
        const rendererResult = getRendererInfo(Object.assign({}, args, {
            includeProperties: true,
            includeTextures: true,
            includePasses: !!args.includePasses
        }));
        if (!rendererResult.success) {
            return rendererResult;
        }
        const data = rendererResult.data;
        const checks = [];
        const tolerance = Number(args.tolerance) || 0.001;
        if (typeof args.nodeActive === 'boolean') {
            pushValidation(checks, 'nodeActive', args.nodeActive, data.node.active, data.node.active === args.nodeActive, data.node.active === args.nodeActive ? '节点 active 符合预期。' : '节点 active 与预期不一致。');
        }
        const renderer = data.renderers[0];
        if (typeof args.rendererEnabled === 'boolean') {
            pushValidation(checks, 'rendererEnabled', args.rendererEnabled, renderer.enabled, renderer.enabled === args.rendererEnabled, renderer.enabled === args.rendererEnabled ? 'Renderer enabled 符合预期。' : 'Renderer enabled 与预期不一致。');
        }
        const slot = Number.isFinite(Number(args.materialSlot)) ? Number(args.materialSlot) : 0;
        const material = renderer.materials.find((item) => Number(item.slot) === slot) || renderer.materials[slot] || renderer.materials[0] || null;
        if (!material) {
            pushValidation(checks, 'material', `slot ${slot}`, null, false, `材质槽 ${slot} 没有运行态材质。`);
        } else {
            if (args.materialName) {
                const passed = valueMatches(material.name, args.materialName, tolerance);
                pushValidation(checks, 'materialName', args.materialName, material.name, passed, passed ? '材质名称符合预期。' : '材质名称与预期不一致。');
            }
            if (args.materialUuid) {
                const actualUuid = material.uuid || material.id;
                const passed = actualUuid === args.materialUuid;
                pushValidation(checks, 'materialUuid', args.materialUuid, actualUuid, passed, passed ? '材质 UUID 符合预期。' : '材质 UUID 与预期不一致。');
            }
            if (args.effectName) {
                const actualEffect = material.effect && material.effect.name || material.shaderName || '';
                const passed = valueMatches(actualEffect, args.effectName, tolerance);
                pushValidation(checks, 'effectName', args.effectName, actualEffect, passed, passed ? 'Effect/Shader 符合预期。' : 'Effect/Shader 与预期不一致。');
            }
            const expectedProperties = args.expectedProperties || args.properties || null;
            if (expectedProperties && typeof expectedProperties === 'object') {
                for (const [key, expected] of Object.entries(expectedProperties)) {
                    const actual = material.properties ? material.properties[key] : undefined;
                    const passed = valueMatches(actual, expected, tolerance);
                    pushValidation(checks, `property.${key}`, expected, actual, passed, passed ? `材质属性 ${key} 符合预期。` : `材质属性 ${key} 与预期不一致。`);
                }
            }
            const expectedTextures = args.expectedTextures || args.textures || null;
            if (expectedTextures && typeof expectedTextures === 'object') {
                for (const [key, expected] of Object.entries(expectedTextures)) {
                    const actual = material.textures ? material.textures[key] : undefined;
                    const actualText = actual && (actual.name || actual.id || actual.uuid || actual.type) || '';
                    const passed = valueMatches(actualText, expected, tolerance);
                    pushValidation(checks, `texture.${key}`, expected, actual, passed, passed ? `纹理 ${key} 符合预期。` : `纹理 ${key} 与预期不一致。`);
                }
            }
        }
        return {
            success: true,
            data: {
                passed: checks.every((item) => item.passed),
                node: data.node,
                renderer: renderer ? {
                    component: renderer.component,
                    enabled: renderer.enabled,
                    type: renderer.type,
                    mesh: renderer.mesh
                } : null,
                materialSlot: slot,
                actualMaterial: material,
                checks,
                rendererInfo: data
            }
        };
    }

    function topEntries(map, limit) {
        return Object.entries(map)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([name, count]) => ({ name, count }));
    }

    function recentImportantLogs(limit) {
        const count = Math.max(0, Math.min(Number(limit) || 20, 100));
        return consoleLogs
            .filter((item) => item && (item.level === 'warn' || item.level === 'error'))
            .slice(-count)
            .map((item) => ({
                index: item.index,
                level: item.level,
                time: item.time,
                text: String(item.text || '').slice(0, 500)
            }));
    }

    function analyzeFrame(args) {
        args = args || {};
        const scene = getScene();
        if (!scene) {
            return { success: false, error: '当前网页没有可读取的 Cocos 运行场景。', data: checkSupport() };
        }
        const includeNodes = !!args.includeNodes;
        const includeInactive = !!args.includeInactive;
        const maxNodes = Math.max(1, Math.min(Number(args.maxNodes) || 80, 1000));
        const logLimit = Math.max(0, Math.min(Number(args.logLimit) || 20, 100));
        const nodes = collectNodes();
        const componentTypes = {};
        const materialMap = new Map();
        const effectMap = {};
        const textureMap = new Map();
        const renderersByMaterial = {};
        const renderersByMesh = {};
        const meshMap = new Map();
        const renderers = [];
        const cameras = [];
        const lights = [];
        const particles = [];
        const colliders = [];
        const rigidbodies = [];
        const animations = [];
        let componentCount = 0;
        let activeNodeCount = 0;
        let inactiveNodeCount = 0;
        let maxDepth = 0;
        let enabledRendererCount = 0;
        let disabledRendererCount = 0;
        let materialSlotCount = 0;
        for (const item of nodes) {
            const active = isNodeActive(item.node);
            if (active) {
                activeNodeCount++;
            } else {
                inactiveNodeCount++;
            }
            maxDepth = Math.max(maxDepth, item.path ? item.path.split('/').length : 0);
            for (const component of getComponents(item.node)) {
                componentCount++;
                const type = getComponentType(component);
                const kind = componentKind(type);
                const enabled = typeof component.enabled === 'boolean' ? component.enabled : true;
                componentTypes[type] = (componentTypes[type] || 0) + 1;
                const summary = {
                    node: item.path,
                    nodeUuid: getNodeUuid(item.node),
                    type,
                    enabled,
                    active,
                    position: readPosition(item.node)
                };
                if (kind === 'renderer') {
                    const materials = readMaterials(component, {
                        includeProperties: args.includeProperties !== false,
                        includeTextures: args.includeTextures !== false,
                        includePasses: !!args.includePasses,
                        props: Array.isArray(args.props) ? args.props : undefined
                    });
                    const mesh = readMesh(component);
                    for (const material of materials) {
                        materialMap.set(material.id, material);
                        materialSlotCount++;
                        const effectName = material.effect && material.effect.name || material.shaderName || 'UnknownEffect';
                        effectMap[effectName] = (effectMap[effectName] || 0) + 1;
                        renderersByMaterial[material.id] = renderersByMaterial[material.id] || {
                            id: material.id,
                            name: material.name,
                            effect: effectName,
                            rendererCount: 0,
                            nodes: []
                        };
                        renderersByMaterial[material.id].rendererCount++;
                        if (renderersByMaterial[material.id].nodes.length < 20) {
                            renderersByMaterial[material.id].nodes.push(item.path);
                        }
                        for (const [textureKey, texture] of Object.entries(material.textures || {})) {
                            const textureId = texture.id || texture.name || `${material.id}:${textureKey}`;
                            if (!textureMap.has(textureId)) {
                                textureMap.set(textureId, Object.assign({ keys: [], materialIds: [] }, texture));
                            }
                            const textureInfo = textureMap.get(textureId);
                            if (!textureInfo.keys.includes(textureKey)) {
                                textureInfo.keys.push(textureKey);
                            }
                            if (!textureInfo.materialIds.includes(material.id)) {
                                textureInfo.materialIds.push(material.id);
                            }
                        }
                    }
                    if (mesh) {
                        meshMap.set(mesh.id, mesh);
                        renderersByMesh[mesh.id] = renderersByMesh[mesh.id] || {
                            id: mesh.id,
                            name: mesh.name,
                            rendererCount: 0,
                            nodes: []
                        };
                        renderersByMesh[mesh.id].rendererCount++;
                        if (renderersByMesh[mesh.id].nodes.length < 20) {
                            renderersByMesh[mesh.id].nodes.push(item.path);
                        }
                    }
                    if (enabled && active) {
                        enabledRendererCount++;
                    } else {
                        disabledRendererCount++;
                    }
                    if (renderers.length < maxNodes && (includeInactive || active)) {
                        renderers.push(Object.assign({}, summary, {
                            materialCount: materials.length,
                            materials: materials.slice(0, 6),
                            mesh
                        }));
                    }
                } else if (kind === 'camera') {
                    cameras.push(summary);
                } else if (kind === 'light') {
                    lights.push(summary);
                } else if (kind === 'particle') {
                    particles.push(summary);
                } else if (kind === 'collider') {
                    colliders.push(summary);
                } else if (kind === 'rigidbody') {
                    rigidbodies.push(summary);
                } else if (kind === 'animation') {
                    animations.push(summary);
                }
            }
        }
        const profiler = collectProfilerStats();
        const importantLogs = recentImportantLogs(logLimit);
        const materialReuseRatio = enabledRendererCount > 0 ? materialMap.size / enabledRendererCount : null;
        const meshReuseRatio = enabledRendererCount > 0 ? meshMap.size / enabledRendererCount : null;
        const batchingSuggestions = [];
        if (typeof profiler.drawCalls === 'number' && profiler.drawCalls > 80) {
            batchingSuggestions.push('Draw call 偏高，优先检查材质、Pass、宏、纹理状态是否一致，再考虑静态合批、动态合批或 GPU Instancing。');
        }
        if (materialReuseRatio !== null && materialReuseRatio > 0.75 && enabledRendererCount > 3) {
            batchingSuggestions.push('材质复用率偏低，多个渲染器可能各用各的材质实例，会增加合批难度。');
        }
        if (meshReuseRatio !== null && meshReuseRatio < 0.5 && enabledRendererCount > 5) {
            batchingSuggestions.push('网格复用率较高，可以检查相同 Mesh 是否适合 GPU Instancing。');
        }
        if (typeof profiler.triangles === 'number' && profiler.triangles > 200000) {
            batchingSuggestions.push('三角面数量较高，合批只能减少提交次数，仍需要检查模型面数、LOD 或遮挡裁剪。');
        }
        const batchingPressure = (typeof profiler.drawCalls === 'number' && profiler.drawCalls > 80)
            || (materialReuseRatio !== null && materialReuseRatio > 0.75 && enabledRendererCount > 3)
            ? '需要关注'
            : '正常';
        const batching = {
            pressure: batchingPressure,
            drawCalls: profiler.drawCalls,
            frameTimeMs: profiler.frameTimeMs,
            rendererTimeMs: profiler.rendererTimeMs,
            triangles: profiler.triangles,
            instances: profiler.instances,
            enabledRendererCount,
            uniqueMaterialCount: materialMap.size,
            uniqueMeshCount: meshMap.size,
            materialReuseRatio,
            meshReuseRatio,
            suggestions: batchingSuggestions
        };
        const warnings = [];
        if (nodes.length > 1000) {
            warnings.push({ level: 'warn', code: 'many_nodes', message: `节点数量较多：${nodes.length}` });
        }
        if (enabledRendererCount > 200) {
            warnings.push({ level: 'warn', code: 'many_renderers', message: `启用的渲染组件较多：${enabledRendererCount}` });
        }
        if (batchingSuggestions.length) {
            warnings.push({ level: batchingPressure === '需要关注' ? 'warn' : 'info', code: 'batching_pressure', message: batchingSuggestions[0] });
        }
        if (materialMap.size > 0 && enabledRendererCount > 0 && materialMap.size / enabledRendererCount > 0.75) {
            warnings.push({ level: 'info', code: 'many_unique_materials', message: `材质复用率可能偏低：${materialMap.size} 个材质 / ${enabledRendererCount} 个启用渲染组件` });
        }
        if (cameras.length > 3) {
            warnings.push({ level: 'info', code: 'many_cameras', message: `相机数量较多：${cameras.length}` });
        }
        if (lights.length > 8) {
            warnings.push({ level: 'info', code: 'many_lights', message: `灯光数量较多：${lights.length}` });
        }
        if (importantLogs.some((item) => item.level === 'error')) {
            warnings.push({ level: 'warn', code: 'runtime_errors', message: '运行态控制台存在 error 日志，请优先检查。' });
        }
        return {
            success: true,
            data: {
                capturedAt: new Date().toISOString(),
                bridgeVersion: VERSION,
                url: location.href,
                sceneName: getSceneName(scene),
                profiler,
                nodes: {
                    total: nodes.length,
                    active: activeNodeCount,
                    inactive: inactiveNodeCount,
                    maxDepth
                },
                components: {
                    total: componentCount,
                    types: componentTypes,
                    topTypes: topEntries(componentTypes, 12)
                },
                rendering: {
                    rendererCount: enabledRendererCount + disabledRendererCount,
                    enabledRendererCount,
                    disabledRendererCount,
                    cameraCount: cameras.length,
                    lightCount: lights.length,
                    particleCount: particles.length,
                    uniqueMaterialCount: materialMap.size,
                    uniqueMeshCount: meshMap.size,
                    renderers: includeNodes ? renderers : undefined,
                    cameras: cameras.slice(0, maxNodes),
                    lights: lights.slice(0, maxNodes),
                    particles: particles.slice(0, maxNodes)
                },
                materials: {
                    totalSlots: materialSlotCount,
                    unique: materialMap.size,
                    uniqueTextureCount: textureMap.size,
                    byEffect: topEntries(effectMap, 12),
                    byMaterial: Object.values(renderersByMaterial).sort((a, b) => b.rendererCount - a.rendererCount).slice(0, 30),
                    byMesh: Object.values(renderersByMesh).sort((a, b) => b.rendererCount - a.rendererCount).slice(0, 30),
                    textures: Array.from(textureMap.values()).slice(0, 50),
                    list: Array.from(materialMap.values()).slice(0, 50)
                },
                batching,
                physics: {
                    rigidbodyCount: rigidbodies.length,
                    colliderCount: colliders.length
                },
                animation: {
                    animationComponentCount: animations.length
                },
                logs: {
                    stored: consoleLogs.length,
                    warnOrErrorRecent: importantLogs
                },
                warnings
            }
        };
    }

    function checkSupport() {
        const cc = getCc();
        const director = getDirector(cc);
        const scene = getScene();
        const childCount = scene ? getChildren(scene).length : 0;
        return {
            support: !!cc,
            hasCc: !!cc,
            hasDirector: !!director,
            ready: isRuntimeReady({ requireNodes: false }),
            hasScene: !!scene,
            sceneName: getSceneName(scene),
            sceneChildCount: childCount,
            url: location.href,
            bridgeVersion: VERSION,
            diagnostics: getRuntimeDiagnostics(cc, scene)
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
                    children: getChildren(scene).map((child) => buildSceneTree(child, getNodeName(child), args, 0))
                };
                return { success: true, data: root };
            }
            case 'find_node':
                return { success: true, data: findNodes(args) };
            case 'find_nodes_by_component':
                return findNodesByComponent(args);
            case 'get_node_info': {
                const found = findNode(args.node || args.query || args.uuid || args.path);
                if (!found) {
                    return { success: false, error: `未找到节点：${args.node || args.query || args.uuid || args.path || ''}` };
                }
                return { success: true, data: nodeSummary(found.node, found.path) };
            }
            case 'get_component_info':
                return componentInfo(args);
            case 'get_component_detail':
                return componentDetail(args);
            case 'get_renderer_info':
                return getRendererInfo(args);
            case 'validate_material_runtime':
                return validateMaterialRuntime(args);
            case 'get_property_path':
                return getPropertyPath(args);
            case 'call_component_method':
                return await callComponentMethod(args);
            case 'get_console_logs':
                return await getConsoleLogs(args);
            case 'set_node_active':
                return setNodeActive(args);
            case 'set_node_transform':
                return setNodeTransform(args);
            case 'debug_draw_ray':
                return debugDrawRay(args);
            case 'debug_draw_collider':
                return debugDrawCollider(args);
            case 'debug_draw_all_colliders':
                return debugDrawAllColliders(args);
            case 'debug_add_collider':
                return debugAddCollider(args);
            case 'debug_clear_drawings':
                return debugClearDrawings(args);
            case 'debug_set_visibility':
                return debugSetVisibility(args);
            case 'analyze_frame':
            case 'capture_frame':
                return analyzeFrame(args);
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
        if (state.polling) {
            return;
        }
        state.polling = true;
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

    function startPollLoopWhenSafe() {
        const start = () => {
            setTimeout(() => {
                pollLoop().catch(() => {});
            }, 1500);
        };
        if (document.readyState === 'complete') {
            start();
        } else {
            window.addEventListener('load', start, { once: true });
            setTimeout(start, 8000);
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
        findNodesByComponent: function (component) {
            return execute({ action: 'find_nodes_by_component', args: { component } });
        },
        getNodeInfo: function (node) {
            return execute({ action: 'get_node_info', args: { node } });
        },
        getComponentDetail: function (node, component, options) {
            return execute({
                action: 'get_component_detail',
                args: Object.assign({}, options || {}, { node, component })
            });
        },
        callComponentMethod: function (node, component, method, args, options) {
            return execute({
                action: 'call_component_method',
                args: Object.assign({}, options || {}, {
                    node,
                    component,
                    method,
                    args: Array.isArray(args) ? args : []
                })
            });
        },
        getPropertyPath: function (node, component, propertyPath, options) {
            return execute({
                action: 'get_property_path',
                args: Object.assign({}, options || {}, { node, component, propertyPath })
            });
        },
        getConsoleLogs: function (options) {
            return execute({ action: 'get_console_logs', args: options || {} });
        },
        analyzeFrame: function (options) {
            return execute({ action: 'analyze_frame', args: options || {} });
        },
        captureFrame: function (options) {
            return execute({ action: 'capture_frame', args: options || {} });
        }
    };

    installConsoleCapture();
    installRuntimeErrorCapture();
    flushEarlyRuntimeErrors();
    register().catch((error) => {
        state.connected = false;
        state.lastError = error && error.message ? error.message : String(error);
        state.clientId = null;
    });
    setInterval(() => {
        heartbeat().catch(() => {});
    }, 3000);
    startPollLoopWhenSafe();
})();
