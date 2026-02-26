import { ImportSettings } from '../engine/import/importer.js';
import { AddDomElement } from '../engine/viewer/domutils.js';
import { Viewer } from '../engine/viewer/viewer.js';
import { ThreeModelLoaderUI } from './threemodelloaderui.js';
import { ThemeHandler } from './themehandler.js';
import { Theme } from './settings.js';
import { Direction } from '../engine/geometry/geometry.js';
import { InputFile, InputFilesFromUrls, InputFilesFromFileObjects } from '../engine/import/importerfiles.js';
import { FileSource } from '../engine/io/fileutils.js';
import { RGBAColor } from '../engine/model/color.js';
import * as THREE from 'three';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import { Exporter } from '../engine/export/exporter.js';
import { ExporterModel, ExporterSettings } from '../engine/export/exportermodel.js';
import { Coord3D } from '../engine/geometry/coord3d.js';
import { Matrix } from '../engine/geometry/matrix.js';
import { FileFormat } from '../engine/io/fileutils.js';

import * as fflate from 'fflate';

export class EmbeddedWebsite {
    constructor(parameters) {
        this.parameters = parameters;
        this.viewer = new Viewer();
        this.modelLoaderUI = new ThreeModelLoaderUI();
        this.themeHandler = new ThemeHandler();
        this.model = null;
        this.threeObject = null;
    }

    Load() {
        let canvas = AddDomElement(this.parameters.viewerDiv, 'canvas');
        this.viewer.Init(canvas);

        this.ApplySystemTheme();

        this.Resize();

        this.RegisterBridgeFunctions();

        window.addEventListener('resize', () => {
            this.Resize();
        });

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            this.ApplySystemTheme();
        });
    }

    ApplyTheme(isDark) {
        if (isDark) {
            this.themeHandler.SwitchTheme(Theme.Dark);
            this.viewer.SetBackgroundColor(new RGBAColor(10, 10, 10, 255));
        } else {
            this.themeHandler.SwitchTheme(Theme.Light);
            this.viewer.SetBackgroundColor(new RGBAColor(255, 255, 255, 255));
        }
    }

    ApplySystemTheme() {
        let isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        this.ApplyTheme(isDark);
    }

    Resize() {
        let windowWidth = window.innerWidth;
        let windowHeight = window.innerHeight;
        this.viewer.Resize(windowWidth, windowHeight);
    }

    LoadInputFiles(inputFiles, name, url) {
        return new Promise((resolve, reject) => {
            this.viewer.Clear();
            this.model = null;
            this.threeObject = null;

            let settings = new ImportSettings();

            this.modelLoaderUI.LoadModel(inputFiles, settings, {
                onStart: () => {

                },
                onFinish: (importResult, threeObject) => {
                    this.model = importResult.model;
                    this.threeObject = threeObject;
                    this.OnModelFinished(threeObject);
                    resolve({
                        success: true,
                        name: name || url || 'model'
                    });
                },
                onRender: () => {
                    this.viewer.Render();
                },
                onError: (importError) => {
                    reject({
                        success: false,
                        error: importError.message || 'Failed to load model'
                    });
                }
            });
        });
    }

    RegisterBridgeFunctions() {
        window.loadExternalModel = (url, name) => {
            let inputFiles;
            if (name) {
                inputFiles = [new InputFile(name, FileSource.Url, url)];
            } else {
                inputFiles = InputFilesFromUrls([url]);
            }
            return this.LoadInputFiles(inputFiles, name, url);
        };

        window.loadLocalFile = (file) => {
            let inputFiles = InputFilesFromFileObjects([file]);
            return this.LoadInputFiles(inputFiles, file.name, null);
        };

        window.exportModel = (format, extension, rotation) => {
            return new Promise((resolve, reject) => {
                if (this.model === null) {
                    reject({ success: false, error: 'No model loaded' });
                    return;
                }

                let formatType = format === 'binary' ? FileFormat.Binary : FileFormat.Text;
                let settings = new ExporterSettings();

                // Normalize rotation: accept number (backward compat) or {x, y, z} object
                let rot;
                if (typeof rotation === 'number') {
                    rot = { x: rotation, y: 0, z: 0 };
                } else if (rotation && typeof rotation === 'object') {
                    rot = { x: rotation.x || 0, y: rotation.y || 0, z: rotation.z || 0 };
                } else {
                    rot = { x: 0, y: 0, z: 0 };
                }

                if (rot.x !== 0 || rot.y !== 0 || rot.z !== 0) {
                    let combined = new Matrix().CreateIdentity();
                    if (rot.x !== 0) {
                        combined = combined.MultiplyMatrix(
                            new Matrix().CreateRotationAxisAngle(new Coord3D(1, 0, 0), (rot.x * Math.PI) / 180)
                        );
                    }
                    if (rot.y !== 0) {
                        combined = combined.MultiplyMatrix(
                            new Matrix().CreateRotationAxisAngle(new Coord3D(0, 1, 0), (rot.y * Math.PI) / 180)
                        );
                    }
                    if (rot.z !== 0) {
                        combined = combined.MultiplyMatrix(
                            new Matrix().CreateRotationAxisAngle(new Coord3D(0, 0, 1), (rot.z * Math.PI) / 180)
                        );
                    }
                    settings.transformation.SetMatrix(combined);
                }

                let exporterModel = new ExporterModel(this.model, settings);
                if (exporterModel.MeshInstanceCount() === 0) {
                    reject({ success: false, error: 'Model has no meshes' });
                    return;
                }

                let exporter = new Exporter();
                exporter.Export(this.model, settings, formatType, extension, {
                    onError: () => {
                        reject({ success: false, error: 'Export failed' });
                    },
                    onSuccess: (files) => {
                        if (files.length === 0) {
                            reject({ success: false, error: 'Export produced no files' });
                        } else if (files.length === 1) {
                            let file = files[0];
                            let content = file.GetBufferContent();
                            resolve({ success: true, name: file.GetName(), binary: new Uint8Array(content) });
                        } else {
                            let filesInZip = {};
                            for (let file of files) {
                                filesInZip[file.name] = new Uint8Array(file.content);
                            }
                            let zipped = fflate.zipSync(filesInZip);
                            resolve({ success: true, name: 'model.zip', binary: new Uint8Array(zipped) });
                        }
                    }
                });
            });
        };

        window.exportCurrentModelToUSDZ = () => {
            return new Promise((resolve, reject) => {
                if (this.threeObject === null) {
                    reject({
                        success: false,
                        error: 'No model loaded'
                    });
                    return;
                }

                // Convert non-MeshStandardMaterial to MeshStandardMaterial
                // so USDZExporter can handle them. Swap in-place and restore after.
                let originalMaterials = new Map();
                this.threeObject.traverse((child) => {
                    if (!child.isMesh || !child.material) {
                        return;
                    }
                    let mats = Array.isArray(child.material) ? child.material : [child.material];
                    let needsConvert = mats.some((m) => !m.isMeshStandardMaterial || m.side === THREE.DoubleSide);
                    if (!needsConvert) {
                        return;
                    }
                    originalMaterials.set(child, child.material);
                    let converted = mats.map((mat) => {
                        if (mat.isMeshStandardMaterial && mat.side !== THREE.DoubleSide) {
                            return mat;
                        }
                        let std = new THREE.MeshStandardMaterial();
                        if (mat.color) { std.color.copy(mat.color); }
                        if (mat.map) { std.map = mat.map; }
                        if (mat.normalMap) { std.normalMap = mat.normalMap; }
                        if (mat.emissive) { std.emissive.copy(mat.emissive); }
                        if (mat.emissiveMap) { std.emissiveMap = mat.emissiveMap; }
                        if (mat.opacity !== undefined) { std.opacity = mat.opacity; }
                        if (mat.transparent !== undefined) { std.transparent = mat.transparent; }
                        if (mat.alphaMap) { std.alphaMap = mat.alphaMap; }
                        if (mat.roughness !== undefined) { std.roughness = mat.roughness; } else { std.roughness = 0.7; }
                        if (mat.metalness !== undefined) { std.metalness = mat.metalness; } else { std.metalness = 0.0; }
                        std.side = THREE.FrontSide;
                        return std;
                    });
                    child.material = converted.length === 1 ? converted[0] : converted;
                });

                // Center the model at origin for USDZ so pivot is at geometric center
                let bbox = new THREE.Box3().setFromObject(this.threeObject);
                let center = bbox.getCenter(new THREE.Vector3());
                let originalPosition = this.threeObject.position.clone();
                this.threeObject.position.sub(center);
                this.threeObject.updateMatrixWorld(true);

                let exporter = new USDZExporter();
                let restore = () => {
                    for (let [mesh, mat] of originalMaterials) {
                        mesh.material = mat;
                    }
                    this.threeObject.position.copy(originalPosition);
                    this.threeObject.updateMatrixWorld(true);
                };

                exporter.parseAsync(this.threeObject).then((arrayBuffer) => {
                    restore();
                    resolve({
                        success: true,
                        binary: new Uint8Array(arrayBuffer),
                        mimeType: 'model/vnd.usdz+zip'
                    });
                }).catch((err) => {
                    restore();
                    reject({
                        success: false,
                        error: err.message || 'Failed to export USDZ'
                    });
                });
            });
        };

        let currentIsDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

        window.setTheme = (isDark) => {
            currentIsDark = isDark;
            this.ApplyTheme(isDark);
            updateRulerTheme();
        };

        let xrayState = { enabled: false, originals: new Map() };

        window.setXRayMode = (enabled) => {
            // Always restore originals first to handle stale refs after model reload
            for (let [mat, orig] of xrayState.originals) {
                mat.transparent = orig.transparent;
                mat.opacity = orig.opacity;
                mat.depthWrite = orig.depthWrite;
                mat.side = orig.side;
                mat.needsUpdate = true;
            }
            xrayState.originals.clear();

            if (enabled && this.threeObject) {
                this.threeObject.traverse((child) => {
                    if (!child.isMesh || !child.material) {
                        return;
                    }
                    let mats = Array.isArray(child.material) ? child.material : [child.material];
                    for (let mat of mats) {
                        if (!xrayState.originals.has(mat)) {
                            xrayState.originals.set(mat, {
                                transparent: mat.transparent,
                                opacity: mat.opacity,
                                depthWrite: mat.depthWrite,
                                side: mat.side
                            });
                        }
                        mat.transparent = true;
                        mat.opacity = 0.15;
                        mat.depthWrite = false;
                        mat.side = THREE.DoubleSide;
                        mat.needsUpdate = true;
                    }
                });
            }
            xrayState.enabled = enabled;
            this.viewer.Render();
        };

        let edgeState = { enabled: false, lines: [], angle: 15, color: 0xffffff };

        let rebuildEdges = () => {
            // Remove existing
            for (let line of edgeState.lines) {
                if (line.parent) {
                    line.parent.remove(line);
                }
                line.geometry.dispose();
                line.material.dispose();
            }
            edgeState.lines = [];

            if (!edgeState.enabled || !this.threeObject) {
                return;
            }

            this.threeObject.traverse((child) => {
                if (!child.isMesh || !child.geometry) {
                    return;
                }
                let edgesGeometry = new THREE.EdgesGeometry(child.geometry, edgeState.angle);
                let edgeMaterial = new THREE.LineBasicMaterial({
                    color: edgeState.color,
                    transparent: true,
                    opacity: 0.8
                });
                let lineSegments = new THREE.LineSegments(edgesGeometry, edgeMaterial);
                child.add(lineSegments);
                edgeState.lines.push(lineSegments);
            });
        };

        window.setEdgeMode = (enabled) => {
            if (enabled === edgeState.enabled) {
                return;
            }
            edgeState.enabled = enabled;
            rebuildEdges();
            this.viewer.Render();
        };

        window.setEdgeAngle = (angle) => {
            edgeState.angle = angle;
            if (edgeState.enabled) {
                rebuildEdges();
                this.viewer.Render();
            }
        };

        window.setEdgeColor = (hexColor) => {
            edgeState.color = hexColor;
            if (edgeState.enabled) {
                for (let line of edgeState.lines) {
                    line.material.color.set(hexColor);
                    line.material.needsUpdate = true;
                }
                this.viewer.Render();
            }
        };

        window.getMeshList = () => {
            if (!this.threeObject) {
                return [];
            }
            let meshes = [];
            let index = 0;
            this.threeObject.traverse((child) => {
                if (child.isMesh) {
                    meshes.push({
                        index: index,
                        name: child.name || ('Mesh ' + (index + 1))
                    });
                    index++;
                }
            });
            return meshes;
        };

        window.setMeshVisibility = (index, visible) => {
            if (!this.threeObject) {
                return;
            }
            let current = 0;
            this.threeObject.traverse((child) => {
                if (child.isMesh) {
                    if (index === -1 || current === index) {
                        child.visible = visible;
                    }
                    current++;
                }
            });
            this.viewer.Render();
        };

        // --- Scale Ruler ---
        let rulerGroup = null;
        let rulerLineMaterial = null;
        let rulerLabelSprites = { x: null, y: null, z: null };
        let rulerTickSprites = [];  // { sprite, rawValue } for tick number labels
        let currentViewDirection = 'front';
        let currentRulerMeshIndex = undefined;
        let lastRulerLabels = null;  // { w, h, d, unitFactor }
        this.justLoaded = false;

        // Edge placement per camera direction:
        // [xRulerY, xRulerZ, yRulerX, yRulerZ, zRulerX, zRulerY]
        // -1 = min side, +1 = max side
        const rulerEdgeMap = {
            front:  [-1, +1, -1, +1, -1, -1],
            back:   [-1, -1, +1, -1, +1, -1],
            left:   [-1, -1, -1, -1, -1, -1],
            right:  [-1, +1, +1, +1, +1, -1],
            top:    [+1, +1, -1, +1, -1, +1],
            bottom: [-1, -1, -1, -1, -1, -1],
        };

        function rulerLineColor() { return currentIsDark ? 0xaaaaaa : 0x555555; }
        function rulerLineOpacity() { return currentIsDark ? 0.95 : 0.9; }
        function rulerTickFill() { return currentIsDark ? 'rgba(240, 240, 240, 1.0)' : 'rgba(30, 30, 30, 1.0)'; }
        function rulerLabelFill() { return currentIsDark ? '#ffffff' : '#222222'; }

        function createTextSprite(text, fontSize) {
            let canvas = document.createElement('canvas');
            let ctx = canvas.getContext('2d');
            let font = `bold ${fontSize}px sans-serif`;
            ctx.font = font;
            let metrics = ctx.measureText(text);
            let textWidth = metrics.width;
            let textHeight = fontSize;
            let padX = fontSize * 0.6;
            let padY = fontSize * 0.4;
            let w = textWidth + padX * 2;
            let h = textHeight + padY * 2;
            canvas.width = w * 2;
            canvas.height = h * 2;
            ctx.scale(2, 2);
            ctx.fillStyle = currentIsDark ? 'rgba(0, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.85)';
            let r = fontSize * 0.3;
            ctx.beginPath();
            ctx.moveTo(r, 0);
            ctx.lineTo(w - r, 0);
            ctx.quadraticCurveTo(w, 0, w, r);
            ctx.lineTo(w, h - r);
            ctx.quadraticCurveTo(w, h, w - r, h);
            ctx.lineTo(r, h);
            ctx.quadraticCurveTo(0, h, 0, h - r);
            ctx.lineTo(0, r);
            ctx.quadraticCurveTo(0, 0, r, 0);
            ctx.closePath();
            ctx.fill();
            ctx.font = font;
            ctx.fillStyle = rulerLabelFill();
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
            ctx.fillText(text, w / 2, h / 2);
            let texture = new THREE.CanvasTexture(canvas);
            texture.needsUpdate = true;
            let material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
            let sprite = new THREE.Sprite(material);
            sprite.userData.labelText = text;
            return { sprite, aspect: w / h };
        }

        function updateSpriteText(sprite, text, fontSize) {
            if (!sprite || !sprite.material || !sprite.material.map) {
                return;
            }
            let oldTexture = sprite.material.map;
            let canvas = document.createElement('canvas');
            let ctx = canvas.getContext('2d');
            let font = `bold ${fontSize}px sans-serif`;
            ctx.font = font;
            let metrics = ctx.measureText(text);
            let textWidth = metrics.width;
            let textHeight = fontSize;
            let padX = fontSize * 0.6;
            let padY = fontSize * 0.4;
            let w = textWidth + padX * 2;
            let h = textHeight + padY * 2;
            canvas.width = w * 2;
            canvas.height = h * 2;
            ctx.scale(2, 2);
            ctx.fillStyle = currentIsDark ? 'rgba(0, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.85)';
            let r = fontSize * 0.3;
            ctx.beginPath();
            ctx.moveTo(r, 0);
            ctx.lineTo(w - r, 0);
            ctx.quadraticCurveTo(w, 0, w, r);
            ctx.lineTo(w, h - r);
            ctx.quadraticCurveTo(w, h, w - r, h);
            ctx.lineTo(r, h);
            ctx.quadraticCurveTo(0, h, 0, h - r);
            ctx.lineTo(0, r);
            ctx.quadraticCurveTo(0, 0, r, 0);
            ctx.closePath();
            ctx.fill();
            ctx.font = font;
            ctx.fillStyle = rulerLabelFill();
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
            ctx.fillText(text, w / 2, h / 2);
            let texture = new THREE.CanvasTexture(canvas);
            texture.needsUpdate = true;
            sprite.material.map = texture;
            sprite.material.needsUpdate = true;
            oldTexture.dispose();
            let aspect = w / h;
            let scaleY = sprite.scale.y;
            sprite.scale.set(scaleY * aspect, scaleY, 1);
            sprite.userData.labelText = text;
        }

        // Find a mesh by traversal index, or return null for whole model
        function findMeshByIndex(threeObject, meshIndex) {
            if (meshIndex === undefined || meshIndex === null || meshIndex < 0) {
                return null;
            }
            let current = 0;
            let target = null;
            threeObject.traverse((child) => {
                if (child.isMesh) {
                    if (current === meshIndex) {
                        target = child;
                    }
                    current++;
                }
            });
            return target;
        }

        window.getModelDimensions = (meshIndex) => {
            if (!this.threeObject) {
                return null;
            }
            let target = findMeshByIndex(this.threeObject, meshIndex);
            let obj = target || this.threeObject;
            let box = new THREE.Box3().setFromObject(obj);
            let size = new THREE.Vector3();
            box.getSize(size);
            return { width: size.x, height: size.y, depth: size.z };
        };

        // Pick a "nice" step size that yields roughly `divisions` intervals
        function niceStep(length, divisions) {
            let rough = length / (divisions || 10);
            let mag = Math.pow(10, Math.floor(Math.log10(rough)));
            let residual = rough / mag;
            let nice;
            if (residual <= 1.5) { nice = 1; }
            else if (residual <= 3.5) { nice = 2; }
            else if (residual <= 7.5) { nice = 5; }
            else { nice = 10; }
            return nice * mag;
        }

        // Format a tick number: drop unnecessary decimals
        function formatTickNum(val) {
            if (Math.abs(val) < 1e-9) { return '0'; }
            if (Number.isInteger(val) || Math.abs(val - Math.round(val)) < 1e-9) {
                return String(Math.round(val));
            }
            let s = val.toFixed(2);
            // strip trailing zeros after decimal
            s = s.replace(/\.?0+$/, '');
            return s;
        }

        // Create a small plain-text sprite (no background) for tick numbers
        function createTickLabel(text, fontSize) {
            let canvas = document.createElement('canvas');
            let ctx = canvas.getContext('2d');
            let font = `${fontSize}px sans-serif`;
            ctx.font = font;
            let metrics = ctx.measureText(text);
            let w = Math.ceil(metrics.width) + 4;
            let h = fontSize + 4;
            canvas.width = w * 2;
            canvas.height = h * 2;
            ctx.scale(2, 2);
            ctx.font = font;
            ctx.fillStyle = rulerTickFill();
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
            ctx.fillText(text, w / 2, h / 2);
            let texture = new THREE.CanvasTexture(canvas);
            texture.needsUpdate = true;
            let material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
            let sprite = new THREE.Sprite(material);
            return { sprite, aspect: w / h };
        }

        // Update an existing tick label sprite with new text
        function updateTickSpriteText(sprite, text, fontSize, baseScale) {
            if (!sprite || !sprite.material || !sprite.material.map) { return; }
            let oldTexture = sprite.material.map;
            let canvas = document.createElement('canvas');
            let ctx = canvas.getContext('2d');
            let font = `${fontSize}px sans-serif`;
            ctx.font = font;
            let metrics = ctx.measureText(text);
            let w = Math.ceil(metrics.width) + 4;
            let h = fontSize + 4;
            canvas.width = w * 2;
            canvas.height = h * 2;
            ctx.scale(2, 2);
            ctx.font = font;
            ctx.fillStyle = rulerTickFill();
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
            ctx.fillText(text, w / 2, h / 2);
            let texture = new THREE.CanvasTexture(canvas);
            texture.needsUpdate = true;
            sprite.material.map = texture;
            sprite.material.needsUpdate = true;
            oldTexture.dispose();
            let aspect = w / h;
            sprite.scale.set(baseScale * aspect, baseScale, 1);
        }

        // Build graduated ticks along a ruler line with numeric labels.
        // start/end: Vector3, tickDir: Vector3 (unit perpendicular direction),
        // labelOffsetDir: Vector3 (direction to offset number labels from the ruler),
        // majorLen/minorLen: tick heights, labelOffset: distance for number sprites,
        // spriteScale: base scale for tick number sprites, material: LineBasicMaterial
        function addGraduatedTicks(group, start, end, tickDir, labelOffsetDir, majorLen, minorLen, labelOffset, spriteScale, material) {
            let axis = new THREE.Vector3().subVectors(end, start);
            let length = axis.length();
            if (length < 1e-10) { return; }
            let dir = axis.clone().normalize();
            let tickFontSize = 16;
            let numScale = spriteScale * 0.35;

            // Estimate label width in 3D units (aspect ~2.5x height)
            let labelWidth = numScale * 3;
            // Determine how many major-tick labels can fit without overlapping
            let maxLabels = Math.max(2, Math.floor(length / (labelWidth * 1.5)));
            let targetDivs = Math.min(10, maxLabels);
            let step = niceStep(length, targetDivs);

            // Show minor ticks only when half-step spacing exceeds label width
            let showMinor = (step / 2) > labelWidth * 1.2;
            let tickStep = showMinor ? step / 2 : step;

            // Add "0" label at start
            {
                let result = createTickLabel('0', tickFontSize);
                let s = result.sprite;
                s.position.copy(start).addScaledVector(labelOffsetDir, labelOffset);
                s.scale.set(numScale * result.aspect, numScale, 1);
                group.add(s);
                rulerTickSprites.push({ sprite: s, rawValue: 0, fontSize: tickFontSize, baseScale: numScale });
            }

            for (let d = 0; d <= length + step * 0.001; d += tickStep) {
                if (d < -1e-10) { continue; }
                let t = Math.min(d, length);
                let isMajor = (Math.abs(Math.round(d / step) * step - d) < step * 0.01);
                // Skip ticks very close to ends (those are already drawn as end ticks)
                if (t < step * 0.05 || t > length - step * 0.05) { continue; }
                let len = isMajor ? majorLen : minorLen;
                let pos = start.clone().addScaledVector(dir, t);
                let p1 = pos.clone().addScaledVector(tickDir, -len);
                let p2 = pos.clone().addScaledVector(tickDir, len);
                let geom = new THREE.BufferGeometry().setFromPoints([p1, p2]);
                group.add(new THREE.Line(geom, material));

                // Add number label at major ticks
                if (isMajor) {
                    let text = formatTickNum(t);
                    let result = createTickLabel(text, tickFontSize);
                    let s = result.sprite;
                    s.position.copy(pos).addScaledVector(labelOffsetDir, labelOffset);
                    s.scale.set(numScale * result.aspect, numScale, 1);
                    group.add(s);
                    rulerTickSprites.push({ sprite: s, rawValue: t, fontSize: tickFontSize, baseScale: numScale });
                }
            }

            // Add final value label at end (the actual dimension length)
            {
                let text = formatTickNum(length);
                let result = createTickLabel(text, tickFontSize);
                let s = result.sprite;
                s.position.copy(end).addScaledVector(labelOffsetDir, labelOffset);
                s.scale.set(numScale * result.aspect, numScale, 1);
                group.add(s);
                rulerTickSprites.push({ sprite: s, rawValue: length, fontSize: tickFontSize, baseScale: numScale });
            }
        }

        function setRulerGroupOpacity(group, factor) {
            if (!group) return;
            group.traverse((child) => {
                if (child.material) {
                    child.material.opacity = child.material.isLineBasicMaterial
                        ? rulerLineOpacity() * factor
                        : factor;
                    child.material.needsUpdate = true;
                }
            });
        }

        function updateRulerTheme() {
            if (!rulerGroup) { return; }
            // Update line material color
            if (rulerLineMaterial) {
                rulerLineMaterial.color.set(rulerLineColor());
                rulerLineMaterial.opacity = rulerLineOpacity();
                rulerLineMaterial.needsUpdate = true;
            }
            // Re-paint main dimension labels
            let fontSize = 28;
            for (let key of ['x', 'y', 'z']) {
                let s = rulerLabelSprites[key];
                if (s && s.userData.labelText) {
                    updateSpriteText(s, s.userData.labelText, fontSize);
                }
            }
            // Re-paint tick number labels
            for (let entry of rulerTickSprites) {
                let text = entry.sprite.userData.labelText || formatTickNum(entry.rawValue);
                updateTickSpriteText(entry.sprite, text, entry.fontSize, entry.baseScale);
            }
            this.viewer.Render();
        }

        window.setScaleRuler = (enabled, meshIndex) => {
            if (!this.threeObject) {
                return;
            }
            currentRulerMeshIndex = meshIndex;
            if (!enabled) {
                if (rulerGroup) {
                    this.viewer.ClearExtra();
                    rulerGroup = null;
                    rulerLabelSprites = { x: null, y: null, z: null };
                    rulerTickSprites = [];
                    this.viewer.Render();
                }
                return;
            }
            // On initial load with ruler enabled, set camera to eye level immediately
            if (this.justLoaded) {
                this.justLoaded = false;
                let camera = this.viewer.GetCamera();
                let cx = camera.center.x, cy = camera.center.y, cz = camera.center.z;
                let ex = camera.eye.x, ey = camera.eye.y, ez = camera.eye.z;
                let dist = Math.sqrt((ex - cx) ** 2 + (ey - cy) ** 2 + (ez - cz) ** 2);
                camera.eye = new Coord3D(cx, cy, cz + dist);
                camera.up = new Coord3D(0.0, 1.0, 0.0);
                this.viewer.SetCamera(camera);
                let bs = this.viewer.GetBoundingSphere(() => true);
                this.viewer.AdjustClippingPlanesToSphere(bs);
                currentViewDirection = 'front';
            }
            // Remove existing ruler if any
            if (rulerGroup) {
                this.viewer.ClearExtra();
                rulerGroup = null;
                rulerTickSprites = [];
            }

            let target = findMeshByIndex(this.threeObject, meshIndex);
            let obj = target || this.threeObject;
            let box = new THREE.Box3().setFromObject(obj);
            let size = new THREE.Vector3();
            box.getSize(size);
            let min = box.min.clone();

            let group = new THREE.Group();
            let lineMaterial = new THREE.LineBasicMaterial({ color: rulerLineColor(), depthTest: false, transparent: true, opacity: rulerLineOpacity() });
            rulerLineMaterial = lineMaterial;
            let maxDim = Math.max(size.x, size.y, size.z);
            let majorTick = maxDim * 0.038;
            let minorTick = maxDim * 0.022;
            let endTick = maxDim * 0.042;
            let fontSize = 28;
            let spriteScale = maxDim * 0.055;

            // Offset amounts (8% of perpendicular dims)
            let offsetY = size.y * 0.08;
            let offsetZ = size.z * 0.08;
            let offsetX = size.x * 0.08;

            let sides = rulerEdgeMap[currentViewDirection] || rulerEdgeMap.front;
            let isTopBottom = (currentViewDirection === 'top' || currentViewDirection === 'bottom');
            let isLeftRight = (currentViewDirection === 'left' || currentViewDirection === 'right');

            // Determine if each ruler should be reversed so "0" is at the common corner
            let reverseX = (sides[2] === +1); // Y ruler at max.x → X "0" should be at max.x
            let reverseY = (sides[0] === +1); // X ruler at max.y → Y "0" should be at max.y
            let reverseZ = (sides[1] === +1); // X ruler at max.z → Z "0" should be at max.z

            // X axis ruler
            {
                let xY = sides[0] === -1 ? min.y - offsetY : min.y + size.y + offsetY;
                let xZ = sides[1] === +1 ? min.z + size.z + offsetZ : min.z - offsetZ;
                let startX = reverseX
                    ? new THREE.Vector3(min.x + size.x, xY, xZ)
                    : new THREE.Vector3(min.x, xY, xZ);
                let endX = reverseX
                    ? new THREE.Vector3(min.x, xY, xZ)
                    : new THREE.Vector3(min.x + size.x, xY, xZ);
                let geom = new THREE.BufferGeometry().setFromPoints([startX, endX]);
                group.add(new THREE.Line(geom, lineMaterial));
                // End ticks — perpendicular axis depends on view direction
                let xTickVec = isTopBottom
                    ? new THREE.Vector3(0, 0, endTick)
                    : new THREE.Vector3(0, endTick, 0);
                let tickGeom1 = new THREE.BufferGeometry().setFromPoints([
                    startX.clone().sub(xTickVec), startX.clone().add(xTickVec),
                ]);
                group.add(new THREE.Line(tickGeom1, lineMaterial));
                let tickGeom2 = new THREE.BufferGeometry().setFromPoints([
                    endX.clone().sub(xTickVec), endX.clone().add(xTickVec),
                ]);
                group.add(new THREE.Line(tickGeom2, lineMaterial));
                // Graduated ticks with numbers
                let tickDirX, labelDirX;
                if (isTopBottom) {
                    tickDirX = new THREE.Vector3(0, 0, -sides[1]);
                    labelDirX = new THREE.Vector3(0, 0, sides[1]);
                } else {
                    tickDirX = new THREE.Vector3(0, -sides[0], 0);
                    labelDirX = new THREE.Vector3(0, sides[0], 0);
                }
                addGraduatedTicks(group, startX, endX, tickDirX, labelDirX, majorTick, minorTick, endTick * 2, spriteScale, lineMaterial);
                // Main dimension label
                let labelResult = createTextSprite(size.x.toFixed(2), fontSize);
                let labelSprite = labelResult.sprite;
                labelSprite.position.copy(startX).lerp(endX, 0.5);
                if (isTopBottom) {
                    labelSprite.position.z += sides[1] * endTick * 4.5;
                } else {
                    labelSprite.position.y += sides[0] * endTick * 4.5;
                }
                labelSprite.scale.set(spriteScale * labelResult.aspect, spriteScale, 1);
                group.add(labelSprite);
                rulerLabelSprites.x = labelSprite;
            }

            // Y axis ruler
            {
                let yX = sides[2] === -1 ? min.x - offsetX : min.x + size.x + offsetX;
                let yZ = sides[3] === +1 ? min.z + size.z + offsetZ : min.z - offsetZ;
                let startY = reverseY
                    ? new THREE.Vector3(yX, min.y + size.y, yZ)
                    : new THREE.Vector3(yX, min.y, yZ);
                let endY = reverseY
                    ? new THREE.Vector3(yX, min.y, yZ)
                    : new THREE.Vector3(yX, min.y + size.y, yZ);
                let geom = new THREE.BufferGeometry().setFromPoints([startY, endY]);
                group.add(new THREE.Line(geom, lineMaterial));
                // End ticks — perpendicular axis depends on view direction
                let yTickVec = isLeftRight
                    ? new THREE.Vector3(0, 0, endTick)
                    : new THREE.Vector3(endTick, 0, 0);
                let tickGeom1 = new THREE.BufferGeometry().setFromPoints([
                    startY.clone().sub(yTickVec), startY.clone().add(yTickVec),
                ]);
                group.add(new THREE.Line(tickGeom1, lineMaterial));
                let tickGeom2 = new THREE.BufferGeometry().setFromPoints([
                    endY.clone().sub(yTickVec), endY.clone().add(yTickVec),
                ]);
                group.add(new THREE.Line(tickGeom2, lineMaterial));
                // Graduated ticks with numbers
                let tickDirY, labelDirY;
                if (isLeftRight) {
                    tickDirY = new THREE.Vector3(0, 0, -sides[3]);
                    labelDirY = new THREE.Vector3(0, 0, sides[3]);
                } else {
                    tickDirY = new THREE.Vector3(-sides[2], 0, 0);
                    labelDirY = new THREE.Vector3(sides[2], 0, 0);
                }
                addGraduatedTicks(group, startY, endY, tickDirY, labelDirY, majorTick, minorTick, endTick * 2, spriteScale, lineMaterial);
                // Main dimension label
                let labelResult = createTextSprite(size.y.toFixed(2), fontSize);
                let labelSprite = labelResult.sprite;
                labelSprite.position.copy(startY).lerp(endY, 0.5);
                if (isLeftRight) {
                    labelSprite.position.z += sides[3] * endTick * 4.5;
                } else {
                    labelSprite.position.x += sides[2] * endTick * 4.5;
                }
                labelSprite.scale.set(spriteScale * labelResult.aspect, spriteScale, 1);
                group.add(labelSprite);
                rulerLabelSprites.y = labelSprite;
            }

            // Z axis ruler
            {
                let zX = sides[4] === -1 ? min.x - offsetX : min.x + size.x + offsetX;
                let zY = sides[5] === -1 ? min.y - offsetY : min.y + size.y + offsetY;
                let startZ = reverseZ
                    ? new THREE.Vector3(zX, zY, min.z + size.z)
                    : new THREE.Vector3(zX, zY, min.z);
                let endZ = reverseZ
                    ? new THREE.Vector3(zX, zY, min.z)
                    : new THREE.Vector3(zX, zY, min.z + size.z);
                let geom = new THREE.BufferGeometry().setFromPoints([startZ, endZ]);
                group.add(new THREE.Line(geom, lineMaterial));
                // End ticks — perpendicular axis depends on view direction
                let zTickVec = isTopBottom
                    ? new THREE.Vector3(endTick, 0, 0)
                    : new THREE.Vector3(0, endTick, 0);
                let tickGeom1 = new THREE.BufferGeometry().setFromPoints([
                    startZ.clone().sub(zTickVec), startZ.clone().add(zTickVec),
                ]);
                group.add(new THREE.Line(tickGeom1, lineMaterial));
                let tickGeom2 = new THREE.BufferGeometry().setFromPoints([
                    endZ.clone().sub(zTickVec), endZ.clone().add(zTickVec),
                ]);
                group.add(new THREE.Line(tickGeom2, lineMaterial));
                // Graduated ticks with numbers
                let tickDirZ, labelDirZ;
                if (isTopBottom) {
                    tickDirZ = new THREE.Vector3(-sides[4], 0, 0);
                    labelDirZ = new THREE.Vector3(sides[4], 0, 0);
                } else {
                    tickDirZ = new THREE.Vector3(0, -sides[5], 0);
                    labelDirZ = new THREE.Vector3(0, sides[5], 0);
                }
                addGraduatedTicks(group, startZ, endZ, tickDirZ, labelDirZ, majorTick, minorTick, endTick * 2, spriteScale, lineMaterial);
                // Main dimension label
                let labelResult = createTextSprite(size.z.toFixed(2), fontSize);
                let labelSprite = labelResult.sprite;
                labelSprite.position.copy(startZ).lerp(endZ, 0.5);
                if (isTopBottom) {
                    labelSprite.position.x += sides[4] * endTick * 4.5;
                } else {
                    labelSprite.position.y += sides[5] * endTick * 4.5;
                }
                labelSprite.scale.set(spriteScale * labelResult.aspect, spriteScale, 1);
                group.add(labelSprite);
                rulerLabelSprites.z = labelSprite;
            }

            rulerGroup = group;
            this.viewer.AddExtraObject(group);

            // Reapply cached labels if available
            if (lastRulerLabels) {
                window.updateRulerLabels(lastRulerLabels.w, lastRulerLabels.h, lastRulerLabels.d, lastRulerLabels.unitFactor);
            }
        };

        window.updateRulerLabels = (widthLabel, heightLabel, depthLabel, unitFactor) => {
            lastRulerLabels = { w: widthLabel, h: heightLabel, d: depthLabel, unitFactor };
            let fontSize = 28;
            if (rulerLabelSprites.x) {
                updateSpriteText(rulerLabelSprites.x, widthLabel, fontSize);
            }
            if (rulerLabelSprites.y) {
                updateSpriteText(rulerLabelSprites.y, heightLabel, fontSize);
            }
            if (rulerLabelSprites.z) {
                updateSpriteText(rulerLabelSprites.z, depthLabel, fontSize);
            }
            // Update tick number labels with new unit factor
            if (unitFactor !== undefined) {
                for (let i = 0; i < rulerTickSprites.length; i++) {
                    let entry = rulerTickSprites[i];
                    let converted = entry.rawValue * unitFactor;
                    let text = formatTickNum(converted);
                    updateTickSpriteText(entry.sprite, text, entry.fontSize, entry.baseScale);
                }
            }
            this.viewer.Render();
        };

        window.focusMesh = (index) => {
            if (!this.threeObject) {
                return;
            }

            let sphere;
            if (index === -1) {
                sphere = this.viewer.GetBoundingSphere((meshUserData) => {
                    return true;
                });
            } else {
                let current = 0;
                let targetMesh = null;
                this.threeObject.traverse((child) => {
                    if (child.isMesh) {
                        if (current === index) {
                            targetMesh = child;
                        }
                        current++;
                    }
                });
                if (!targetMesh) {
                    return;
                }
                let box = new THREE.Box3().setFromObject(targetMesh);
                sphere = new THREE.Sphere();
                box.getBoundingSphere(sphere);
            }

            this.viewer.AdjustClippingPlanesToSphere(sphere);
            this.viewer.FitSphereToWindow(sphere, true);
        };

        window.setCameraDirection = (direction) => {
            let dirVec, upVec;
            switch (direction) {
                case 'front':  dirVec = [0, 0, 1];  upVec = [0, 1, 0];  break;
                case 'back':   dirVec = [0, 0, -1]; upVec = [0, 1, 0];  break;
                case 'left':   dirVec = [-1, 0, 0]; upVec = [0, 1, 0];  break;
                case 'right':  dirVec = [1, 0, 0];  upVec = [0, 1, 0];  break;
                case 'top':    dirVec = [0, 1, 0];  upVec = [0, 0, -1]; break;
                case 'bottom': dirVec = [0, -1, 0]; upVec = [0, 0, 1];  break;
                default: return;
            }

            let camera = this.viewer.GetCamera();
            let cx = camera.center.x, cy = camera.center.y, cz = camera.center.z;
            let ex = camera.eye.x, ey = camera.eye.y, ez = camera.eye.z;
            let dist = Math.sqrt((ex - cx) ** 2 + (ey - cy) ** 2 + (ez - cz) ** 2);

            let targetEye = [cx + dirVec[0] * dist, cy + dirVec[1] * dist, cz + dirVec[2] * dist];
            let startEye = [ex, ey, ez];
            let startUp = [camera.up.x, camera.up.y, camera.up.z];

            let hasRuler = rulerGroup !== null;
            let rulerRebuilt = false;
            let duration = 400;
            let startTime = performance.now();
            const animate = (now) => {
                let raw = Math.min((now - startTime) / duration, 1);
                let t = 1 - (1 - raw) * (1 - raw) * (1 - raw); // ease-out cubic

                // Interpolate eye and keep at constant distance (arc, not line)
                let nx = startEye[0] + (targetEye[0] - startEye[0]) * t;
                let ny = startEye[1] + (targetEye[1] - startEye[1]) * t;
                let nz = startEye[2] + (targetEye[2] - startEye[2]) * t;
                let dx = nx - cx, dy = ny - cy, dz = nz - cz;
                let curDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (curDist > 0) {
                    nx = cx + dx / curDist * dist;
                    ny = cy + dy / curDist * dist;
                    nz = cz + dz / curDist * dist;
                }

                // Interpolate & normalize up vector
                let ux = startUp[0] + (upVec[0] - startUp[0]) * t;
                let uy = startUp[1] + (upVec[1] - startUp[1]) * t;
                let uz = startUp[2] + (upVec[2] - startUp[2]) * t;
                let uLen = Math.sqrt(ux * ux + uy * uy + uz * uz);
                if (uLen > 0) { ux /= uLen; uy /= uLen; uz /= uLen; }

                camera.eye = new Coord3D(nx, ny, nz);
                camera.up = new Coord3D(ux, uy, uz);
                this.viewer.SetCamera(camera);

                // Ruler crossfade: fade out first half, rebuild at midpoint, fade in second half
                if (hasRuler) {
                    if (raw < 0.5) {
                        setRulerGroupOpacity(rulerGroup, 1 - raw * 2);
                    } else if (!rulerRebuilt) {
                        currentViewDirection = direction;
                        window.setScaleRuler(true, currentRulerMeshIndex);
                        setRulerGroupOpacity(rulerGroup, 0);
                        rulerRebuilt = true;
                    }
                    if (raw >= 0.5) {
                        setRulerGroupOpacity(rulerGroup, (raw - 0.5) * 2);
                    }
                }

                if (raw < 1) {
                    requestAnimationFrame(animate);
                } else {
                    let boundingSphere = this.viewer.GetBoundingSphere(() => true);
                    this.viewer.AdjustClippingPlanesToSphere(boundingSphere);
                    if (!rulerRebuilt) {
                        currentViewDirection = direction;
                    }
                    if (hasRuler) {
                        if (!rulerRebuilt) {
                            window.setScaleRuler(true, currentRulerMeshIndex);
                        }
                        setRulerGroupOpacity(rulerGroup, 1);
                    }
                }
            };
            requestAnimationFrame(animate);
        };

        window.zoomCamera = (ratio) => {
            this.viewer.navigation.Zoom(ratio);
            this.viewer.navigation.Update();
        };

        let originalRotation = null;

        window.setModelRotation = (xDeg, yDeg, zDeg) => {
            if (this.threeObject === null) return;
            if (originalRotation === null) {
                originalRotation = this.threeObject.rotation.clone();
            }
            this.threeObject.rotation.set(
                (xDeg * Math.PI) / 180,
                (yDeg * Math.PI) / 180,
                (zDeg * Math.PI) / 180,
                'XYZ'
            );
            this.threeObject.updateMatrixWorld(true);
            this.viewer.Render();
        };

        window.resetModelRotation = () => {
            if (this.threeObject === null || originalRotation === null) return;
            this.threeObject.rotation.copy(originalRotation);
            this.threeObject.updateMatrixWorld(true);
            originalRotation = null;
            this.viewer.Render();
        };

        window.resetCamera = () => {
            let camera = this.viewer.GetCamera();
            let cx = camera.center.x, cy = camera.center.y, cz = camera.center.z;
            let ex = camera.eye.x, ey = camera.eye.y, ez = camera.eye.z;
            let dist = Math.sqrt((ex - cx) ** 2 + (ey - cy) ** 2 + (ez - cz) ** 2);

            let targetEye;
            if (rulerGroup) {
                // Ruler on: eye level
                targetEye = [cx, cy, cz + dist];
            } else {
                // Ruler off: 30° above
                let elev = 15 * Math.PI / 180;
                targetEye = [cx, cy + Math.sin(elev) * dist, cz + Math.cos(elev) * dist];
            }
            let startEye = [ex, ey, ez];
            let startUp = [camera.up.x, camera.up.y, camera.up.z];
            let upVec = [0, 1, 0];

            let hasRuler = rulerGroup !== null;
            let rulerRebuilt = false;
            let duration = 400;
            let startTime = performance.now();
            const animate = (now) => {
                let raw = Math.min((now - startTime) / duration, 1);
                let t = 1 - (1 - raw) * (1 - raw) * (1 - raw);

                let nx = startEye[0] + (targetEye[0] - startEye[0]) * t;
                let ny = startEye[1] + (targetEye[1] - startEye[1]) * t;
                let nz = startEye[2] + (targetEye[2] - startEye[2]) * t;
                let dx = nx - cx, dy = ny - cy, dz = nz - cz;
                let curDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (curDist > 0) {
                    nx = cx + dx / curDist * dist;
                    ny = cy + dy / curDist * dist;
                    nz = cz + dz / curDist * dist;
                }

                let ux = startUp[0] + (upVec[0] - startUp[0]) * t;
                let uy = startUp[1] + (upVec[1] - startUp[1]) * t;
                let uz = startUp[2] + (upVec[2] - startUp[2]) * t;
                let uLen = Math.sqrt(ux * ux + uy * uy + uz * uz);
                if (uLen > 0) { ux /= uLen; uy /= uLen; uz /= uLen; }

                camera.eye = new Coord3D(nx, ny, nz);
                camera.up = new Coord3D(ux, uy, uz);
                this.viewer.SetCamera(camera);

                // Ruler crossfade
                if (hasRuler) {
                    if (raw < 0.5) {
                        setRulerGroupOpacity(rulerGroup, 1 - raw * 2);
                    } else if (!rulerRebuilt) {
                        currentViewDirection = 'front';
                        window.setScaleRuler(true, currentRulerMeshIndex);
                        setRulerGroupOpacity(rulerGroup, 0);
                        rulerRebuilt = true;
                    }
                    if (raw >= 0.5) {
                        setRulerGroupOpacity(rulerGroup, (raw - 0.5) * 2);
                    }
                }

                if (raw < 1) {
                    requestAnimationFrame(animate);
                } else {
                    let boundingSphere = this.viewer.GetBoundingSphere(() => true);
                    boundingSphere.radius *= 1.3;
                    this.viewer.AdjustClippingPlanesToSphere(boundingSphere);
                    this.viewer.FitSphereToWindow(boundingSphere, true);
                    if (!rulerRebuilt) {
                        currentViewDirection = 'front';
                    }
                    if (hasRuler) {
                        if (!rulerRebuilt) {
                            window.setScaleRuler(true, currentRulerMeshIndex);
                        }
                        setRulerGroupOpacity(rulerGroup, 1);
                    }
                }
            };
            requestAnimationFrame(animate);
        };

        let autoRotateId = null;
        let autoRotatePrev = null;

        window.startAutoRotate = (hSpeed, tiltDeg) => {
            if (autoRotateId !== null) return;
            autoRotatePrev = performance.now();
            let elapsed = 0;
            const freq = Math.PI / 4; // period ≈ 8 seconds
            const tick = (now) => {
                let dt = (now - autoRotatePrev) / 1000;
                autoRotatePrev = now;
                elapsed += dt;
                let vDelta = tiltDeg > 0 ? tiltDeg * freq * Math.cos(freq * elapsed) * dt : 0;
                this.viewer.navigation.Orbit(hSpeed * dt, vDelta);
                this.viewer.navigation.Update();
                autoRotateId = requestAnimationFrame(tick);
            };
            autoRotateId = requestAnimationFrame(tick);
        };

        window.stopAutoRotate = () => {
            if (autoRotateId !== null) {
                cancelAnimationFrame(autoRotateId);
                autoRotateId = null;
                autoRotatePrev = null;
            }
        };
    }

    OnModelFinished(threeObject) {
        this.viewer.SetMainObject(threeObject);
        this.viewer.SetUpVector(Direction.Y, false);

        // Position camera at front, 15° above horizontal
        let camera = this.viewer.GetCamera();
        let elevation = 15 * Math.PI / 180;
        camera.eye = new Coord3D(0.0, Math.sin(elevation) * 3.5, Math.cos(elevation) * 3.5);
        camera.center = new Coord3D(0.0, 0.0, 0.0);
        camera.up = new Coord3D(0.0, 1.0, 0.0);
        this.viewer.SetCamera(camera);

        let boundingSphere = this.viewer.GetBoundingSphere(() => true);
        boundingSphere.radius *= 1.3;
        this.viewer.AdjustClippingPlanesToSphere(boundingSphere);
        this.viewer.FitSphereToWindow(boundingSphere, false);
        this.justLoaded = true;
    }
}
