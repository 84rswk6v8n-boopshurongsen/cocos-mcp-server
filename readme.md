# Cocos MCP Server

Cocos MCP Server 是一个面向 Cocos Creator 3.7+ / 3.8.x 的 MCP 插件，让支持 MCP 的 AI 客户端可以读取和操作 Cocos 工程、场景、节点、组件、资源、动画和预览运行态。

插件提供编辑器面板、MCP 服务启动入口、工具管理和运行可视化能力，适合用 AI 辅助完成 UI 搭建、节点编辑、资源查询、动画配置、场景检查和浏览器预览调试。

## 主要能力

- 在 Cocos Creator 内启动 MCP Server，并把编辑器能力暴露给 AI 客户端。
- 通过工具管理面板查看、启用和配置已注册工具。
- 支持场景、节点、组件、预制体、资源、编辑器、视图、UI 模板、构建、动画等常用工作流。
- 支持浏览器预览状态查询和运行态桥接，便于 AI 理解预览页面里的实际节点树。
- 支持 Animation Mask 和 Animation Graph 等 Cocos Creator 3.8.x 动画资源编辑。

## 安装

1. 将 `cocos-mcp-server` 文件夹放入 Cocos Creator 项目的 `extensions/` 目录。
2. 打开或重启 Cocos Creator。
3. 在顶部菜单中打开 MCP Server 面板。
4. 启动 MCP 服务，并按面板生成的配置接入 Claude、Cursor、Codex 等 MCP 客户端。

更多安装说明见 [INSTALL.md](./INSTALL.md)。

## 20 个工具简表

| 工具 | 功能简介 |
| --- | --- |
| `scene` | 场景管理工具，用于打开、保存、创建场景，读取层级，查询场景状态，执行撤销事务，检测场景引用和组件类型。 |
| `node` | 节点工具，用于查找、创建、修改、移动、复制、删除节点，设置 Transform，挂载或移除脚本，并支持批量修改。 |
| `component` | 组件工具，用于添加、移除、查看和配置组件属性，查询可用组件类型，绑定按钮点击事件并支持批量绑定。 |
| `prefab` | 预制体工具，用于查询、创建、实例化、删除、进入编辑、保存编辑、应用或回退预制体变更。 |
| `asset` | 资源工具，用于搜索、创建、复制、移动、删除、导入、刷新资源，查询依赖，以及在 UUID、路径和 URL 之间转换。 |
| `editor` | 编辑器工具，用于读取项目信息、运行或停止预览、构建项目、打开构建面板、读取日志、管理偏好设置和重载编辑器。 |
| `view` | 视图工具，用于切换 Gizmo、2D/3D 模式、网格、图标显示，聚焦节点，对齐相机，并管理参考图。 |
| `composite` | 复合 UI 工具，用一次调用创建按钮、文本、图片等完整 UI，也可挂载脚本并完成属性绑定，适合快速搭建界面。 |
| `knowledge` | 知识查询工具，用于查询 Cocos 组件属性、UI 规则、布局模式、动画配方、最佳实践和工具使用指南。 |
| `validate` | 深度校验工具，用于检查 UI 重叠、越界、资源引用一致性、层级深度和命名问题。 |
| `template` | UI 模板工具，用于列出并应用内置模板，例如弹窗、滚动列表、导航栏和设置页。 |
| `capture` | 场景快照工具，用于导出场景或指定节点子树的结构化 JSON，帮助 AI 理解布局、尺寸、位置和组件信息。 |
| `builder` | JSON 构建工具，用于根据声明式节点树一次性创建复杂层级和组件，适合批量生成 UI 或原型结构。 |
| `animation` | 动画工具，用于播放控制、创建和编辑动画剪辑、轨道、关键帧、曲线、事件、预设和批量动画操作。 |
| `spine` | Spine 工具，用于读取 `sp.Skeleton` 动画和皮肤，设置动画、皮肤、属性、骨骼数据和 socket。 |
| `label` | 文本工具，用于管理 `cc.Label`、`cc.RichText`、`cc.EditBox` 的文本、字体、样式、描边、阴影和批量样式。 |
| `runtime` | 运行态桥接工具，用于在浏览器预览页中读取运行时场景树、节点、组件、统计信息，并支持修改节点激活和 Transform。 |
| `preview` | 浏览器预览工具，用于启动、停止和查询预览状态，返回预览地址、端口、启动时间和服务复用情况。 |
| `animation_mask` | Animation Mask 工具，用于创建、查询、更新 `.animask` 资源，批量设置骨骼遮罩，校验骨骼路径。 |
| `animation_graph` | Animation Graph 工具，用于编辑 `.animgraph` 资源，管理参数、状态、连线、过渡条件、Layer，并校验动画图。 |

## 使用建议

- 修改 3 个以上节点时优先使用 `node` 的 `batch_modify`。
- 批量绑定按钮点击事件时优先使用 `component` 的 `batch_click_event`。
- 构建复杂 UI 层级时优先使用 `builder`，简单按钮、文本、图片可用 `composite`。
- 检查断裂资源引用可用 `scene.validate_scene`，做布局和层级深度检查可用 `validate`。
- 不熟悉某个工具 action 时，可先用 `knowledge` 查询 `tool_guide`。

## v1.7.6 更新内容

- 新增 Cocos Web 运行态桥接能力，支持通过浏览器预览页读取运行时场景树、节点、组件和基础统计信息。
- 新增 `cocos_runtime` 工具，支持检查运行态连接、等待场景就绪、查找节点、读取节点信息、读取组件信息、切换节点显隐和修改 Transform。
- 新增运行态代理注入页，可通过 `injectedPreviewUrl` 自动注入 runtime bridge，减少手动在浏览器控制台执行脚本的步骤。
- 优化 runtime bridge 客户端管理，清理旧客户端并拒绝过旧 bridge 版本，避免旧页面干扰 active client 选择。
- 修复预览代理下场景 JSON、socket.io、WASM 和 engine external 资源转发问题，提升 Cocos 预览页运行态读取稳定性。
- 优化启动 MCP 服务器面板，支持端口配置、启动/停止、重启 Cocos 后自动启动、工具列表查看、MCP 地址获取、插件重新加载和版本信息展示。

## 联系

如需支持或定制，可联系：

- QQ: 1799096798
- 微信: 13272695146
