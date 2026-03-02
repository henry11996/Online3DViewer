import { DOMParser as XMLDOMParser } from '@xmldom/xmldom';

// Polyfill DOMParser for workers that lack native support.
// xmldom lacks querySelectorAll/querySelector which THREE.js loaders need.
// Prototype patching doesn't reliably reach all node instances, so we use
// a wrapper DOMParser that patches every document + element per-instance.

function qsaImpl (selector) {
    // Comma-separated selectors
    if (selector.indexOf (',') !== -1) {
        let parts = selector.split (',');
        let results = [];
        for (let i = 0; i < parts.length; i++) {
            let sub = qsaImpl.call (this, parts[i].trim ());
            for (let j = 0; j < sub.length; j++) {
                results.push (sub[j]);
            }
        }
        return results;
    }
    // Descendant selector: "ancestor descendant" (e.g. "vertices vertex")
    let parts = selector.trim ().split (/\s+/);
    if (parts.length > 1) {
        let contexts = [this];
        for (let i = 0; i < parts.length; i++) {
            let nextContexts = [];
            for (let j = 0; j < contexts.length; j++) {
                let nodeList = contexts[j].getElementsByTagName (parts[i]);
                for (let k = 0; k < nodeList.length; k++) {
                    nextContexts.push (nodeList[k]);
                }
            }
            contexts = nextContexts;
        }
        return contexts;
    }
    // Simple tag name
    if (/^[a-zA-Z][\w-]*$/.test (selector)) {
        let nodeList = this.getElementsByTagName (selector);
        let arr = [];
        for (let i = 0; i < nodeList.length; i++) {
            arr.push (nodeList[i]);
        }
        return arr;
    }
    return [];
}

function qsImpl (selector) {
    let results = qsaImpl.call (this, selector);
    return results.length > 0 ? results[0] : null;
}

function patchNode (node) {
    if (!node || node.__qsPatched) {
        return;
    }
    node.__qsPatched = true;
    if (!node.querySelectorAll) { node.querySelectorAll = qsaImpl; }
    if (!node.querySelector) { node.querySelector = qsImpl; }
    // Polyfill .children if missing
    if (node.nodeType === 1 && !('children' in node)) {
        Object.defineProperty (node, 'children', {
            get () {
                let result = [];
                let cn = this.childNodes;
                for (let i = 0; i < cn.length; i++) {
                    if (cn[i].nodeType === 1) { result.push (cn[i]); }
                }
                return result;
            }
        });
    }
    // Recurse into child elements
    if (node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) {
            patchNode (node.childNodes[i]);
        }
    }
}

if (typeof self.DOMParser === 'undefined') {
    self.DOMParser = class PatchedDOMParser {
        parseFromString (text, mimeType) {
            let doc = new XMLDOMParser ().parseFromString (text, mimeType);
            patchNode (doc);
            return doc;
        }
    };
}

import * as THREE from 'three';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { VRMLLoader } from 'three/examples/jsm/loaders/VRMLLoader.js';
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js';

function createNoOpManager () {
    let manager = new THREE.LoadingManager ();
    manager.setURLModifier (() => {
        return 'data:application/octet-stream;base64,';
    });
    return manager;
}

function createLoader (type, manager) {
    switch (type) {
        case '3mf': return new ThreeMFLoader (manager);
        case 'fbx': return new FBXLoader (manager);
        case 'dae': return new ColladaLoader (manager);
        case 'wrl': return new VRMLLoader (manager);
        case 'amf': return new AMFLoader (manager);
        default: return null;
    }
}

function extractMaterialData (material) {
    if (!material) {
        return null;
    }
    let data = {
        type: material.type || 'MeshPhongMaterial',
        name: material.name || '',
        color: material.color ? { r: material.color.r, g: material.color.g, b: material.color.b } : { r: 1, g: 1, b: 1 },
        opacity: material.opacity !== undefined ? material.opacity : 1,
        transparent: !!material.transparent,
        alphaTest: material.alphaTest !== undefined ? material.alphaTest : 0,
        side: material.side !== undefined ? material.side : THREE.FrontSide
    };
    if (material.type === 'MeshPhongMaterial') {
        data.specular = material.specular ? { r: material.specular.r, g: material.specular.g, b: material.specular.b } : null;
        data.shininess = material.shininess !== undefined ? material.shininess : 30;
    }
    return data;
}

function extractMeshData (mesh) {
    let geom = mesh.geometry;
    let data = {
        name: mesh.name || ''
    };

    // Position
    if (geom.attributes.position) {
        data.position = geom.attributes.position.array;
        data.positionItemSize = geom.attributes.position.itemSize || 3;
    }

    // Normal
    if (geom.attributes.normal) {
        data.normal = geom.attributes.normal.array;
        data.normalItemSize = geom.attributes.normal.itemSize || 3;
    }

    // UV
    if (geom.attributes.uv) {
        data.uv = geom.attributes.uv.array;
        data.uvItemSize = geom.attributes.uv.itemSize || 2;
    }

    // Vertex colors
    if (geom.attributes.color) {
        data.color = geom.attributes.color.array;
        data.colorItemSize = geom.attributes.color.itemSize || 3;
    }

    // Index
    if (geom.index) {
        data.index = geom.index.array;
    }

    // Groups
    if (geom.groups && geom.groups.length > 0) {
        data.groups = geom.groups.map ((g) => ({
            start: g.start,
            count: g.count,
            materialIndex: g.materialIndex
        }));
    }

    // Materials
    if (Array.isArray (mesh.material)) {
        data.materials = mesh.material.map ((m) => extractMaterialData (m));
    } else {
        data.materials = [extractMaterialData (mesh.material)];
    }

    return data;
}

function extractHierarchy (object) {
    let node = {
        name: object.name || '',
        type: object.type || 'Object3D',
        matrix: null,
        isMesh: false,
        meshData: null,
        children: []
    };

    // Extract matrix
    object.updateMatrix ();
    if (object.matrix) {
        node.matrix = new Float64Array (object.matrix.elements);
    }

    // If it's a mesh, extract geometry + material data
    if (object.isMesh) {
        node.isMesh = true;
        node.meshData = extractMeshData (object);
    }

    // Visibility for VRML backface check
    if (object.isMesh && object.material) {
        let mats = Array.isArray (object.material) ? object.material : [object.material];
        node.materialSides = mats.map ((m) => m.side);
    }

    // Recurse children
    for (let child of object.children) {
        node.children.push (extractHierarchy (child));
    }

    return node;
}

function collectTransferables (node, set) {
    if (node.meshData) {
        let md = node.meshData;
        if (md.position) { set.add (md.position.buffer); }
        if (md.normal) { set.add (md.normal.buffer); }
        if (md.uv) { set.add (md.uv.buffer); }
        if (md.color) { set.add (md.color.buffer); }
        if (md.index) { set.add (md.index.buffer); }
    }
    if (node.matrix) {
        set.add (node.matrix.buffer);
    }
    for (let child of node.children) {
        collectTransferables (child, set);
    }
}

self.onmessage = function (event) {
    let { type, data } = event.data;

    try {
        let manager = createNoOpManager ();
        let loader = createLoader (type, manager);

        if (!loader) {
            self.postMessage ({
                success: false,
                error: 'Unknown format type: ' + type
            });
            return;
        }

        let result;
        if (type === 'dae') {
            // ColladaLoader.parse expects a string and a path
            let text;
            if (data instanceof ArrayBuffer) {
                text = new TextDecoder ().decode (data);
            } else {
                text = data;
            }
            result = loader.parse (text, '');
        } else if (type === 'wrl') {
            // VRMLLoader.parse expects a string
            let text;
            if (data instanceof ArrayBuffer) {
                text = new TextDecoder ().decode (data);
            } else {
                text = data;
            }
            result = loader.parse (text, '');
        } else {
            // 3MF, FBX, AMF expect ArrayBuffer
            result = loader.parse (data);
        }

        // Get main object (ColladaLoader returns { scene })
        let mainObject;
        if (type === 'dae' && result && result.scene) {
            mainObject = result.scene;
        } else {
            mainObject = result;
        }

        if (!mainObject) {
            self.postMessage ({
                success: false,
                error: 'Parser returned null'
            });
            return;
        }

        let hierarchy = extractHierarchy (mainObject);
        let transferableSet = new Set ();
        collectTransferables (hierarchy, transferableSet);

        self.postMessage ({
            success: true,
            hierarchy: hierarchy,
            formatType: type
        }, Array.from (transferableSet));

    } catch (err) {
        self.postMessage ({
            success: false,
            error: err.message || String (err)
        });
    }
};
