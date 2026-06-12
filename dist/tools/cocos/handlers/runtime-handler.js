'use strict';

const ACTIONS = [
    'get_injection_code',
    'get_injected_preview_url',
    'clear_clients',
    'check_support',
    'wait_until_ready',
    'get_scene_tree',
    'find_node',
    'find_nodes_by_component',
    'get_node_info',
    'get_component_info',
    'get_component_detail',
    'get_property_path',
    'call_component_method',
    'get_console_logs',
    'set_node_active',
    'set_node_transform',
    'get_runtime_stats'
];

class RuntimeHandler {
    getToolDefinition() {
        return {
            name: 'runtime',
            description: [
                'Cocos Web 运行态桥接工具，用于读取浏览器预览页中的运行时场景、节点、组件和基础统计。',
                '使用前需要在预览网页注入 /runtime/bridge.js；本工具只返回精简 JSON，不提供网页 UI。',
                'Actions: get_injection_code, get_injected_preview_url, clear_clients, check_support, wait_until_ready, get_scene_tree, find_node, find_nodes_by_component, get_node_info, get_component_info, get_component_detail, get_property_path, call_component_method, get_console_logs, set_node_active, set_node_transform, get_runtime_stats.'
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ACTIONS,
                        description: '运行态操作'
                    },
                    host: {
                        type: 'string',
                        description: 'get_injection_code 使用的 MCP 主机，默认 127.0.0.1'
                    },
                    port: {
                        type: 'number',
                        description: 'get_injection_code 使用的 MCP 端口，默认当前 MCP 服务端口'
                    },
                    previewUrl: {
                        type: 'string',
                        description: '要自动注入 bridge 的 Cocos 预览页地址，例如 http://127.0.0.1:7456/'
                    },
                    previewHost: {
                        type: 'string',
                        description: '预览页主机，未提供 previewUrl 时使用，默认 127.0.0.1'
                    },
                    previewPort: {
                        type: 'number',
                        description: '预览页端口，未提供 previewUrl 时使用，默认 7456'
                    },
                    node: {
                        type: 'string',
                        description: '节点名称、路径或 UUID'
                    },
                    query: {
                        type: 'string',
                        description: 'find_node 查询文本，可匹配名称、路径或 UUID'
                    },
                    component: {
                        type: 'string',
                        description: '组件类型名或组件 UUID'
                    },
                    componentType: {
                        type: 'string',
                        description: '组件类型名，等同 component'
                    },
                    propertyPath: {
                        type: 'string',
                        description: 'get_property_path 要读取的属性路径，例如 sampleVector.x、node.position.x、materials[0]'
                    },
                    propPath: {
                        type: 'string',
                        description: 'get_property_path 的属性路径别名，等同 propertyPath'
                    },
                    path: {
                        type: 'string',
                        description: '节点路径或 get_property_path 的属性路径；读取属性时建议优先使用 propertyPath'
                    },
                    props: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'get_component_detail 要读取的属性名列表；不传则读取安全字段'
                    },
                    includePrivate: {
                        type: 'boolean',
                        description: 'get_component_detail 是否包含 _ 开头的私有字段，默认 false'
                    },
                    maxArrayLength: {
                        type: 'number',
                        description: '数组属性最大返回数量，默认 20'
                    },
                    method: {
                        type: 'string',
                        description: 'call_component_method 要调用的组件方法名'
                    },
                    args: {
                        type: 'array',
                        items: {},
                        description: 'call_component_method 的参数数组'
                    },
                    allowPrivateMethod: {
                        type: 'boolean',
                        description: '是否允许调用 _ 开头的私有方法，默认 false'
                    },
                    logType: {
                        type: 'string',
                        enum: ['log', 'info', 'warn', 'error', 'debug', 'all'],
                        description: 'get_console_logs 日志类型过滤，默认 all'
                    },
                    keyword: {
                        type: 'string',
                        description: 'get_console_logs 关键字过滤'
                    },
                    limit: {
                        type: 'number',
                        description: 'get_console_logs 返回数量，默认 100'
                    },
                    clear: {
                        type: 'boolean',
                        description: 'get_console_logs 读取后是否清空已收集日志，默认 false'
                    },
                    sinceIndex: {
                        type: 'number',
                        description: 'get_console_logs 只返回 index 大于该值的日志'
                    },
                    waitMs: {
                        type: 'number',
                        description: 'get_console_logs 等待匹配日志出现的最长时间，默认 0'
                    },
                    intervalMs: {
                        type: 'number',
                        description: '等待轮询间隔，默认 100'
                    },
                    active: {
                        type: 'boolean',
                        description: 'set_node_active 要设置的 active 状态'
                    },
                    position: {
                        type: 'object',
                        description: 'set_node_transform 的位置 {x,y,z}'
                    },
                    rotation: {
                        type: 'object',
                        description: 'set_node_transform 的欧拉角 {x,y,z}'
                    },
                    scale: {
                        type: 'object',
                        description: 'set_node_transform 的缩放 {x,y,z}'
                    },
                    maxDepth: {
                        type: 'number',
                        description: 'get_scene_tree 最大递归深度'
                    },
                    nameKeyword: {
                        type: 'string',
                        description: 'get_scene_tree 节点名称/路径筛选关键字'
                    },
                    timeoutMs: {
                        type: 'number',
                        description: '等待浏览器运行态响应的超时时间'
                    },
                    readyTimeoutMs: {
                        type: 'number',
                        description: '读取场景树/统计前等待 Cocos 场景就绪的超时时间'
                    },
                    waitReady: {
                        type: 'boolean',
                        description: 'get_scene_tree/get_runtime_stats 是否自动等待场景就绪，默认 true'
                    },
                    requireNodes: {
                        type: 'boolean',
                        description: 'wait_until_ready 是否要求场景下已有节点，默认 true'
                    }
                },
                required: ['action']
            }
        };
    }

    async execute(args = {}) {
        const action = args.action;
        if (!ACTIONS.includes(action)) {
            return {
                success: false,
                error: `未知运行态操作：${action || ''}`
            };
        }

        const manager = globalThis.__cocosMcpRuntimeBridgeManager;
        if (!manager || typeof manager.execute !== 'function') {
            return {
                success: false,
                error: '运行态桥接管理器尚未初始化，请先启动 MCP 服务器。'
            };
        }

        if (action === 'get_injection_code') {
            return typeof manager.getInjectionCode === 'function'
                ? manager.getInjectionCode(args)
                : {
                    success: false,
                    error: '当前 MCP 服务器不支持生成注入脚本。'
                };
        }

        if (action === 'get_injected_preview_url') {
            return typeof manager.getInjectedPreviewUrl === 'function'
                ? {
                    success: true,
                    data: {
                        injectedPreviewUrl: manager.getInjectedPreviewUrl(args),
                        previewUrl: manager.getDefaultPreviewUrl(args),
                        message: '请打开 injectedPreviewUrl，MCP 会代理 Cocos 预览页并自动注入 runtime bridge。'
                    }
                }
                : {
                    success: false,
                    error: '当前 MCP 服务器不支持生成自动注入预览地址。'
                };
        }

        const result = await manager.execute(action, args);
        if (action === 'check_support' && result && result.success && result.data) {
            return Object.assign({}, result, {
                data: Object.assign({}, result.data, {
                    runtimeStatus: typeof manager.getStatus === 'function' ? manager.getStatus() : null
                })
            });
        }
        return result;
    }
}

module.exports = { RuntimeHandler };
