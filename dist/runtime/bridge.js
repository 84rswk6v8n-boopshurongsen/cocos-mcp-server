'use strict';

(function () {
    const VERSION = '0.1.4';
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
        if (value instanceof Error) {
            return {
                name: value.name,
                message: value.message,
                stack: value.stack
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
        consoleLogs.push({
            index: consoleLogs.length + 1,
            level,
            time: new Date().toISOString(),
            text,
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
        return {
            sceneName: getSceneName(scene),
            sceneIncluded: !!scene,
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
        }
    };

    installConsoleCapture();
    setInterval(() => {
        heartbeat().catch(() => {});
    }, 3000);
    pollLoop();
})();
