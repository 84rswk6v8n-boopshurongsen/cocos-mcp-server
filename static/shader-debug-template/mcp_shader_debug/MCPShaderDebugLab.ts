import { _decorator, assetManager, Camera, Component, director, gfx, Material, MeshRenderer, native, primitives, RenderTexture, utils, Vec3 } from 'cc';

const { ccclass, executeInEditMode, property } = _decorator;

declare const Editor: any;

type TargetDebugInfo = {
    node: string;
    renderer: string;
    slot: number;
    enabled: boolean;
    materialName: string;
    materialUuid: string;
    effectName: string;
    meshUuid: string;
};

type ShaderDebugResult = {
    success: boolean;
    materialRef: string;
    materialUuid: string;
    materialName: string;
    elapsedMs: number;
    targets: TargetDebugInfo[];
    capture: {
        supported: boolean;
        imagePath: string;
        message: string;
        width?: number;
        height?: number;
        format?: string;
        origin?: string;
        pixelsBase64?: string;
        elapsedMs?: number;
        camera?: Record<string, unknown>;
    };
    errors: string[];
};

@ccclass('MCPShaderDebugLab')
@executeInEditMode
export class MCPShaderDebugLab extends Component {
    @property({ type: [MeshRenderer] })
    public targetRenderers: MeshRenderer[] = [];

    @property({ type: [MeshRenderer] })
    public referenceRenderers: MeshRenderer[] = [];

    @property({ type: Camera })
    public captureCamera: Camera | null = null;

    @property
    public captureWidth = 1280;

    @property
    public captureHeight = 720;

    onLoad() {
        this.rebuildGeometry();
    }

    onEnable() {
        this.rebuildGeometry();
    }

    start() {
        this.rebuildGeometry();
    }

    public rebuildGeometry() {
        const renderers = [...this.targetRenderers, ...this.referenceRenderers].filter((renderer) => !!renderer);
        for (const renderer of renderers) {
            this.rebuildRendererMesh(renderer);
        }
        return renderers.every((renderer) => !!((renderer as any).mesh || (renderer as any)._mesh));
    }

    public async applyMaterial(materialUrlOrUuid: string): Promise<ShaderDebugResult> {
        return this.applyMaterialAndCollectDebug(materialUrlOrUuid);
    }

    public async applyMaterialAndCollectDebug(materialUrlOrUuid: string): Promise<ShaderDebugResult> {
        const start = Date.now();
        const errors: string[] = [];
        this.rebuildGeometry();
        const material = await this.loadMaterial(materialUrlOrUuid);

        if (!material) {
            return {
                success: false,
                materialRef: materialUrlOrUuid,
                materialUuid: '',
                materialName: '',
                elapsedMs: Date.now() - start,
                targets: [],
                capture: this.makeCapturePlaceholder(),
                errors: [`Material not found: ${materialUrlOrUuid}`],
            };
        }

        for (const renderer of this.targetRenderers) {
            if (!renderer) {
                errors.push('Missing target renderer reference.');
                continue;
            }
            this.assignMaterial(renderer, material, 0);
        }

        return {
            success: errors.length === 0,
            materialRef: materialUrlOrUuid,
            materialUuid: this.getAssetUuid(material),
            materialName: material.name || '',
            elapsedMs: Date.now() - start,
            targets: this.collectTargetDebugInfo(),
            capture: this.makeCapturePlaceholder(),
            errors,
        };
    }

    public async captureMaterialAndReadPixels(
        materialUrlOrUuid: string,
        width = this.captureWidth,
        height = this.captureHeight,
    ): Promise<ShaderDebugResult> {
        const result = await this.applyMaterialAndCollectDebug(materialUrlOrUuid);
        const captureStart = Date.now();

        if (!result.success) {
            return result;
        }

        const capture = await this.captureCameraPixels(width, height);
        result.capture = {
            ...capture,
            elapsedMs: Date.now() - captureStart,
        };
        result.elapsedMs += result.capture.elapsedMs || 0;
        if (!capture.supported && capture.message) {
            result.errors.push(capture.message);
            result.success = false;
        }

        return result;
    }

    public async captureMaterialAndSavePng(
        materialUrlOrUuid: string,
        filePath: string,
        width = this.captureWidth,
        height = this.captureHeight,
    ): Promise<ShaderDebugResult> {
        const result = await this.captureMaterialAndReadPixels(materialUrlOrUuid, width, height);
        const capture = result.capture;

        if (!result.success || !capture.supported || !capture.pixelsBase64) {
            return result;
        }

        const saveImageData = (native as unknown as { saveImageData?: (data: Uint8Array, width: number, height: number, filePath: string) => Promise<void> }).saveImageData;
        if (typeof saveImageData !== 'function') {
            result.success = false;
            result.errors.push('native.saveImageData is not available in this editor environment.');
            capture.supported = false;
            capture.message = 'native.saveImageData is not available in this editor environment.';
            capture.pixelsBase64 = '';
            return result;
        }

        try {
            const pixels = this.base64ToBytes(capture.pixelsBase64);
            await saveImageData(pixels, capture.width || this.captureWidth, capture.height || this.captureHeight, filePath);
            capture.imagePath = filePath;
            capture.message = 'Captured ShaderDebugCamera and saved PNG.';
            capture.format = 'png';
            capture.pixelsBase64 = '';
        } catch (error) {
            result.success = false;
            result.errors.push(error instanceof Error ? error.message : String(error));
            capture.supported = false;
            capture.message = error instanceof Error ? error.message : String(error);
            capture.pixelsBase64 = '';
        }

        return result;
    }

    public async captureMaterialWithRenderTextureAsset(
        materialUrlOrUuid: string,
        renderTextureUrlOrUuid: string,
        width = this.captureWidth,
        height = this.captureHeight,
    ): Promise<ShaderDebugResult> {
        const result = await this.applyMaterialAndCollectDebug(materialUrlOrUuid);
        const captureStart = Date.now();

        if (!result.success) {
            return result;
        }

        const renderTexture = await this.loadRenderTexture(renderTextureUrlOrUuid);
        if (!renderTexture) {
            result.success = false;
            result.errors.push(`RenderTexture not found: ${renderTextureUrlOrUuid}`);
            result.capture = {
                supported: false,
                imagePath: '',
                message: `RenderTexture not found: ${renderTextureUrlOrUuid}`,
                elapsedMs: Date.now() - captureStart,
            };
            return result;
        }

        const capture = await this.captureCameraPixelsWithTarget(renderTexture, width, height, false);
        result.capture = {
            ...capture,
            message: `${capture.message} RenderTexture asset: ${renderTextureUrlOrUuid}`,
            elapsedMs: Date.now() - captureStart,
        };
        result.elapsedMs += result.capture.elapsedMs || 0;
        if (!capture.supported && capture.message) {
            result.errors.push(capture.message);
            result.success = false;
        }

        return result;
    }

    public collectTargetDebugInfo(): TargetDebugInfo[] {
        return this.targetRenderers
            .filter((renderer) => !!renderer)
            .map((renderer) => {
                const material = this.getRendererMaterial(renderer, 0);
                const effectAsset = material ? (material as any)._effectAsset : null;
                const mesh = (renderer as any).mesh || (renderer as any)._mesh || null;

                return {
                    node: renderer.node ? renderer.node.name : '',
                    renderer: renderer.constructor ? renderer.constructor.name : 'MeshRenderer',
                    slot: 0,
                    enabled: renderer.enabled,
                    materialName: material ? material.name || '' : '',
                    materialUuid: material ? this.getAssetUuid(material) : '',
                    effectName: effectAsset ? effectAsset.name || '' : '',
                    meshUuid: mesh ? this.getAssetUuid(mesh) : '',
                };
            });
    }

    public collectRendererInternalDebug() {
        const renderers = [...this.targetRenderers, ...this.referenceRenderers].filter((renderer) => !!renderer);
        return renderers.map((renderer) => {
            const anyRenderer = renderer as any;
            const mesh = anyRenderer.mesh || anyRenderer._mesh || null;
            const model = anyRenderer.model || anyRenderer._model || anyRenderer._models?.[0] || null;
            const subModels = model && model.subModels ? model.subModels : [];
            const worldBounds = model && model.worldBounds ? model.worldBounds : null;
            const boundsCenter = worldBounds && worldBounds.center ? worldBounds.center : null;
            const boundsHalfExtents = worldBounds && worldBounds.halfExtents ? worldBounds.halfExtents : null;
            const worldPosition = renderer.node ? renderer.node.worldPosition : null;

            return {
                node: renderer.node ? renderer.node.name : '',
                activeInHierarchy: renderer.node ? renderer.node.activeInHierarchy : false,
                enabled: renderer.enabled,
                layer: renderer.node ? renderer.node.layer : 0,
                hasMesh: !!mesh,
                meshUuid: mesh ? this.getAssetUuid(mesh) : '',
                meshType: mesh && mesh.constructor ? mesh.constructor.name : '',
                hasModel: !!model,
                modelType: model && model.constructor ? model.constructor.name : '',
                modelEnabled: model ? model.enabled : null,
                subModelCount: subModels ? subModels.length : 0,
                worldPosition: worldPosition ? {
                    x: worldPosition.x,
                    y: worldPosition.y,
                    z: worldPosition.z,
                } : null,
                worldBounds: worldBounds ? {
                    center: boundsCenter ? {
                        x: boundsCenter.x,
                        y: boundsCenter.y,
                        z: boundsCenter.z,
                    } : null,
                    halfExtents: boundsHalfExtents ? {
                        x: boundsHalfExtents.x,
                        y: boundsHalfExtents.y,
                        z: boundsHalfExtents.z,
                    } : null,
                } : null,
            };
        });
    }

    private assignMaterial(renderer: MeshRenderer, material: Material, slot: number) {
        const anyRenderer = renderer as any;

        if (typeof anyRenderer.setSharedMaterial === 'function') {
            anyRenderer.setSharedMaterial(material, slot);
            return;
        }

        if (typeof anyRenderer.setMaterial === 'function') {
            anyRenderer.setMaterial(material, slot);
            return;
        }

        const sharedMaterials = renderer.sharedMaterials ? renderer.sharedMaterials.slice() : [];
        sharedMaterials[slot] = material;
        renderer.sharedMaterials = sharedMaterials;
    }

    private rebuildRendererMesh(renderer: MeshRenderer) {
        if (!renderer || !renderer.node) {
            return;
        }

        switch (renderer.node.name) {
            case 'Preview_Sphere':
                renderer.mesh = this.createSphereMesh(0.65, 32, 16);
                this.refreshRendererModel(renderer);
                return;
            case 'Preview_Box':
                renderer.mesh = this.createBoxMesh(1, 1, 1);
                this.refreshRendererModel(renderer);
                return;
            case 'Preview_Plane':
                renderer.mesh = utils.createMesh(primitives.plane({
                    width: 2.2,
                    length: 1.35,
                }));
                this.refreshRendererModel(renderer);
                return;
            case 'Reference_Floor':
                renderer.mesh = utils.createMesh(primitives.plane({
                    width: 4.5,
                    length: 3,
                }));
                this.refreshRendererModel(renderer);
                return;
            default:
                return;
        }
    }

    private createBoxMesh(width: number, height: number, length: number) {
        const hx = width * 0.5;
        const hy = height * 0.5;
        const hz = length * 0.5;
        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];

        const faces = [
            { normal: [0, 0, 1], vertices: [[-hx, -hy, hz], [hx, -hy, hz], [-hx, hy, hz], [hx, hy, hz]] },
            { normal: [0, 0, -1], vertices: [[hx, -hy, -hz], [-hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz]] },
            { normal: [1, 0, 0], vertices: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, hz], [hx, hy, -hz]] },
            { normal: [-1, 0, 0], vertices: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, -hz], [-hx, hy, hz]] },
            { normal: [0, 1, 0], vertices: [[-hx, hy, hz], [hx, hy, hz], [-hx, hy, -hz], [hx, hy, -hz]] },
            { normal: [0, -1, 0], vertices: [[-hx, -hy, -hz], [hx, -hy, -hz], [-hx, -hy, hz], [hx, -hy, hz]] },
        ];

        for (const face of faces) {
            const base = positions.length / 3;
            for (const vertex of face.vertices) {
                positions.push(vertex[0], vertex[1], vertex[2]);
                normals.push(face.normal[0], face.normal[1], face.normal[2]);
            }
            uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
            indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        }

        return utils.createMesh({
            positions,
            normals,
            uvs,
            indices,
            primitiveMode: gfx.PrimitiveMode.TRIANGLE_LIST,
            minPos: new Vec3(-hx, -hy, -hz),
            maxPos: new Vec3(hx, hy, hz),
        });
    }

    private createSphereMesh(radius: number, longitudeSegments: number, latitudeSegments: number) {
        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];
        const lon = Math.max(8, Math.floor(longitudeSegments));
        const lat = Math.max(4, Math.floor(latitudeSegments));

        for (let y = 0; y <= lat; y += 1) {
            const v = y / lat;
            const theta = v * Math.PI;
            const sinTheta = Math.sin(theta);
            const cosTheta = Math.cos(theta);

            for (let x = 0; x <= lon; x += 1) {
                const u = x / lon;
                const phi = u * Math.PI * 2;
                const nx = Math.cos(phi) * sinTheta;
                const ny = cosTheta;
                const nz = Math.sin(phi) * sinTheta;
                positions.push(nx * radius, ny * radius, nz * radius);
                normals.push(nx, ny, nz);
                uvs.push(u, v);
            }
        }

        const stride = lon + 1;
        for (let y = 0; y < lat; y += 1) {
            for (let x = 0; x < lon; x += 1) {
                const a = y * stride + x;
                const b = (y + 1) * stride + x;
                const c = a + 1;
                const d = b + 1;
                indices.push(a, b, c, c, b, d);
            }
        }

        return utils.createMesh({
            positions,
            normals,
            uvs,
            indices,
            primitiveMode: gfx.PrimitiveMode.TRIANGLE_LIST,
            minPos: new Vec3(-radius, -radius, -radius),
            maxPos: new Vec3(radius, radius, radius),
        });
    }

    private refreshRendererModel(renderer: MeshRenderer) {
        const anyRenderer = renderer as any;
        const methods = ['onGeometryChanged', '_onMeshChanged', '_updateModels', '_updateModelParams'];

        for (const method of methods) {
            if (typeof anyRenderer[method] === 'function') {
                try {
                    anyRenderer[method]();
                } catch (_) {
                    // Some editor-only private refresh hooks are version dependent.
                }
            }
        }
    }

    private getRendererMaterial(renderer: MeshRenderer, slot: number): Material | null {
        const materials = renderer.sharedMaterials || [];
        return materials[slot] || null;
    }

    private async loadMaterial(materialUrlOrUuid: string): Promise<Material | null> {
        const uuid = await this.resolveUuid(materialUrlOrUuid);
        if (!uuid) {
            return null;
        }

        return new Promise((resolve) => {
            assetManager.loadAny({ uuid }, (error: Error | null, asset: unknown) => {
                if (error || !(asset instanceof Material)) {
                    resolve(null);
                    return;
                }
                resolve(asset);
            });
        });
    }

    private async loadRenderTexture(renderTextureUrlOrUuid: string): Promise<RenderTexture | null> {
        const uuid = await this.resolveUuid(renderTextureUrlOrUuid);
        if (!uuid) {
            return null;
        }

        return new Promise((resolve) => {
            assetManager.loadAny({ uuid }, (error: Error | null, asset: unknown) => {
                if (error || !(asset instanceof RenderTexture)) {
                    resolve(null);
                    return;
                }
                resolve(asset);
            });
        });
    }

    private async resolveUuid(materialUrlOrUuid: string): Promise<string> {
        if (!materialUrlOrUuid) {
            return '';
        }

        if (!materialUrlOrUuid.startsWith('db://')) {
            return materialUrlOrUuid;
        }

        const editor = (globalThis as any).Editor || (typeof Editor !== 'undefined' ? Editor : null);
        if (!editor || !editor.Message || typeof editor.Message.request !== 'function') {
            return '';
        }

        const attempts: [string, string, string][] = [
            ['asset-db', 'query-uuid', materialUrlOrUuid],
            ['asset-db', 'query-asset-uuid', materialUrlOrUuid],
            ['asset-db', 'query-url-to-uuid', materialUrlOrUuid],
        ];

        for (const [channel, message, payload] of attempts) {
            try {
                const result = await editor.Message.request(channel, message, payload);
                if (typeof result === 'string' && result) {
                    return result;
                }
                if (result && typeof result === 'object') {
                    return result.uuid || result.value || '';
                }
            } catch (_) {
                // Try the next editor API variant.
            }
        }

        return '';
    }

    private getAssetUuid(asset: unknown): string {
        const item = asset as { uuid?: string; _uuid?: string };
        return item.uuid || item._uuid || '';
    }

    private async captureCameraPixels(width: number, height: number) {
        if (!this.captureCamera) {
            return {
                supported: false,
                imagePath: '',
                message: 'Missing ShaderDebugCamera reference.',
            };
        }

        const safeWidth = this.clampCaptureSize(width);
        const safeHeight = this.clampCaptureSize(height);
        const renderTexture = new RenderTexture();

        return this.captureCameraPixelsWithTarget(renderTexture, safeWidth, safeHeight, true);
    }

    private async captureCameraPixelsWithTarget(renderTexture: RenderTexture, width: number, height: number, destroyWhenDone: boolean) {
        if (!this.captureCamera) {
            return {
                supported: false,
                imagePath: '',
                message: 'Missing ShaderDebugCamera reference.',
            };
        }

        const safeWidth = this.clampCaptureSize(width);
        const safeHeight = this.clampCaptureSize(height);
        const previousTarget = this.captureCamera.targetTexture;
        const cameraBeforeTarget = this.collectCameraDebugInfo(this.captureCamera, {
            phase: 'beforeTargetTexture',
            requestedWidth: safeWidth,
            requestedHeight: safeHeight,
            renderTextureName: renderTexture.name || '',
        });

        try {
            this.syncCaptureCameraForRender();
            renderTexture.reset({
                name: 'MCP_ShaderDebugCapture',
                width: safeWidth,
                height: safeHeight,
            });
            this.captureCamera.targetTexture = renderTexture;
            this.syncCaptureCameraForRender();
            const cameraAfterTarget = this.collectCameraDebugInfo(this.captureCamera, {
                phase: 'afterTargetTexture',
                requestedWidth: safeWidth,
                requestedHeight: safeHeight,
                renderTextureName: renderTexture.name || '',
            });

            await this.waitForRenderFrames(5);
            this.syncCaptureCameraForRender();
            const cameraBeforeReadPixels = this.collectCameraDebugInfo(this.captureCamera, {
                phase: 'beforeReadPixels',
                requestedWidth: safeWidth,
                requestedHeight: safeHeight,
                renderTextureName: renderTexture.name || '',
            });

            const pixels = renderTexture.readPixels(0, 0, safeWidth, safeHeight);
            if (!pixels || pixels.length < safeWidth * safeHeight * 4) {
                return {
                    supported: false,
                    imagePath: '',
                    message: 'RenderTexture.readPixels returned empty data.',
                    width: safeWidth,
                    height: safeHeight,
                    camera: {
                        beforeTargetTexture: cameraBeforeTarget,
                        afterTargetTexture: cameraAfterTarget,
                        beforeReadPixels: cameraBeforeReadPixels,
                    },
                };
            }

            return {
                supported: true,
                imagePath: '',
                message: 'Captured ShaderDebugCamera render texture.',
                width: safeWidth,
                height: safeHeight,
                format: 'rgba8',
                origin: 'bottom-left',
                pixelsBase64: this.bytesToBase64(pixels),
                camera: {
                    beforeTargetTexture: cameraBeforeTarget,
                    afterTargetTexture: cameraAfterTarget,
                    beforeReadPixels: cameraBeforeReadPixels,
                },
            };
        } catch (error) {
            return {
                supported: false,
                imagePath: '',
                message: error instanceof Error ? error.message : String(error),
                width: safeWidth,
                height: safeHeight,
                camera: {
                    beforeTargetTexture: cameraBeforeTarget,
                },
            };
        } finally {
            this.captureCamera.targetTexture = previousTarget;
            if (destroyWhenDone) {
                renderTexture.destroy();
            }
        }
    }

    private clampCaptureSize(value: number): number {
        const numericValue = Number(value);
        const size = Number.isFinite(numericValue) ? Math.floor(numericValue) : 512;
        return Math.max(1, Math.min(2048, size));
    }

    private syncCaptureCameraForRender() {
        if (!this.captureCamera || !this.captureCamera.node) {
            return;
        }

        const node = this.captureCamera.node as any;
        if (typeof node.updateWorldTransform === 'function') {
            node.updateWorldTransform();
        }

        const renderCamera = (this.captureCamera as any).camera || (this.captureCamera as any)._camera;
        if (renderCamera && typeof renderCamera.update === 'function') {
            renderCamera.update(true);
        }
    }

    private collectCameraDebugInfo(camera: Camera, extra: Record<string, unknown> = {}) {
        const anyCamera = camera as any;
        const node = camera.node;
        const targetTexture = camera.targetTexture as any;
        const internalCamera = anyCamera.camera || anyCamera._camera || null;
        const rect = anyCamera.rect || anyCamera._rect || null;

        return {
            ...extra,
            node: node ? node.name : '',
            nodeUuid: node ? node.uuid : '',
            activeInHierarchy: node ? node.activeInHierarchy : false,
            layer: node ? node.layer : 0,
            worldPosition: this.serializeVec3(node ? node.worldPosition : null),
            worldRotation: this.serializeQuat(node ? node.worldRotation : null),
            eulerAngles: this.serializeVec3(node ? node.eulerAngles : null),
            position: this.serializeVec3(node ? node.position : null),
            rotation: this.serializeQuat(node ? node.rotation : null),
            scale: this.serializeVec3(node ? node.scale : null),
            enabled: camera.enabled,
            priority: anyCamera.priority,
            visibility: anyCamera.visibility,
            projection: anyCamera.projection,
            fov: anyCamera.fov,
            fovAxis: anyCamera.fovAxis,
            orthoHeight: anyCamera.orthoHeight,
            near: anyCamera.near,
            far: anyCamera.far,
            clearFlags: anyCamera.clearFlags,
            clearColor: this.serializeColor(anyCamera.clearColor),
            rect: this.serializeRect(rect),
            aperture: anyCamera.aperture,
            shutter: anyCamera.shutter,
            iso: anyCamera.iso,
            targetTexture: targetTexture ? {
                name: targetTexture.name || '',
                width: targetTexture.width || targetTexture._width || 0,
                height: targetTexture.height || targetTexture._height || 0,
                hash: targetTexture.hash || '',
            } : null,
            internalCamera: internalCamera ? {
                width: internalCamera.width,
                height: internalCamera.height,
                aspect: internalCamera.aspect,
                fov: internalCamera.fov,
                orthoHeight: internalCamera.orthoHeight,
                nearClip: internalCamera.nearClip,
                farClip: internalCamera.farClip,
                clearFlag: internalCamera.clearFlag,
                visibility: internalCamera.visibility,
                windowId: internalCamera.window ? internalCamera.window.id : '',
            } : null,
        };
    }

    private serializeVec3(value: any) {
        return value ? {
            x: value.x,
            y: value.y,
            z: value.z,
        } : null;
    }

    private serializeQuat(value: any) {
        return value ? {
            x: value.x,
            y: value.y,
            z: value.z,
            w: value.w,
        } : null;
    }

    private serializeColor(value: any) {
        return value ? {
            r: value.r,
            g: value.g,
            b: value.b,
            a: value.a,
        } : null;
    }

    private serializeRect(value: any) {
        return value ? {
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
        } : null;
    }

    private async waitForRenderFrames(count: number): Promise<void> {
        for (let index = 0; index < count; index += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 16));
            const root = director.root as unknown as { frameMove?: (dt: number) => void };
            if (root && typeof root.frameMove === 'function') {
                root.frameMove(0);
            }
        }
    }

    private bytesToBase64(bytes: Uint8Array): string {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let output = '';
        let index = 0;

        for (; index + 2 < bytes.length; index += 3) {
            const value = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
            output += alphabet[(value >> 18) & 63];
            output += alphabet[(value >> 12) & 63];
            output += alphabet[(value >> 6) & 63];
            output += alphabet[value & 63];
        }

        if (index < bytes.length) {
            const remaining = bytes.length - index;
            const value = (bytes[index] << 16) | (remaining === 2 ? bytes[index + 1] << 8 : 0);
            output += alphabet[(value >> 18) & 63];
            output += alphabet[(value >> 12) & 63];
            output += remaining === 2 ? alphabet[(value >> 6) & 63] : '=';
            output += '=';
        }

        return output;
    }

    private base64ToBytes(base64: string): Uint8Array {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '');
        const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
        const length = Math.floor(clean.length * 3 / 4) - padding;
        const bytes = new Uint8Array(length);
        let buffer = 0;
        let bits = 0;
        let out = 0;

        for (let index = 0; index < clean.length; index += 1) {
            const char = clean[index];
            if (char === '=') {
                break;
            }
            const value = alphabet.indexOf(char);
            if (value < 0) {
                continue;
            }
            buffer = (buffer << 6) | value;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                if (out < bytes.length) {
                    bytes[out] = (buffer >> bits) & 0xff;
                    out += 1;
                }
            }
        }

        return bytes;
    }

    private makeCapturePlaceholder() {
        return {
            supported: false,
            imagePath: '',
            message: 'Capture ShaderDebugCamera with the MCP editor tool after material assignment.',
        };
    }
}
