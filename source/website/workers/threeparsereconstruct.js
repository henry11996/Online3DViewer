import * as THREE from 'three';

function createThreeMaterial (matData) {
    if (!matData) {
        return new THREE.MeshPhongMaterial ();
    }

    let params = {
        color: new THREE.Color (matData.color.r, matData.color.g, matData.color.b),
        opacity: matData.opacity,
        transparent: matData.transparent,
        alphaTest: matData.alphaTest,
        side: matData.side !== undefined ? matData.side : THREE.FrontSide,
        name: matData.name || ''
    };

    if (matData.type === 'MeshPhongMaterial') {
        if (matData.specular) {
            params.specular = new THREE.Color (matData.specular.r, matData.specular.g, matData.specular.b);
        }
        if (matData.shininess !== undefined) {
            params.shininess = matData.shininess;
        }
        return new THREE.MeshPhongMaterial (params);
    } else if (matData.type === 'MeshStandardMaterial') {
        return new THREE.MeshStandardMaterial (params);
    } else {
        return new THREE.MeshPhongMaterial (params);
    }
}

function reconstructMesh (meshData) {
    let geometry = new THREE.BufferGeometry ();

    if (meshData.position) {
        geometry.setAttribute ('position',
            new THREE.BufferAttribute (meshData.position, meshData.positionItemSize || 3)
        );
    }

    if (meshData.normal) {
        geometry.setAttribute ('normal',
            new THREE.BufferAttribute (meshData.normal, meshData.normalItemSize || 3)
        );
    }

    if (meshData.uv) {
        geometry.setAttribute ('uv',
            new THREE.BufferAttribute (meshData.uv, meshData.uvItemSize || 2)
        );
    }

    if (meshData.color) {
        geometry.setAttribute ('color',
            new THREE.BufferAttribute (meshData.color, meshData.colorItemSize || 3)
        );
    }

    if (meshData.index) {
        geometry.setIndex (new THREE.BufferAttribute (meshData.index, 1));
    }

    if (meshData.groups) {
        for (let group of meshData.groups) {
            geometry.addGroup (group.start, group.count, group.materialIndex);
        }
    }

    // Create materials
    let materials;
    if (meshData.materials && meshData.materials.length > 1) {
        materials = meshData.materials.map ((m) => createThreeMaterial (m));
    } else if (meshData.materials && meshData.materials.length === 1) {
        materials = createThreeMaterial (meshData.materials[0]);
    } else {
        materials = new THREE.MeshPhongMaterial ();
    }

    let mesh = new THREE.Mesh (geometry, materials);
    mesh.name = meshData.name || '';

    return mesh;
}

function reconstructNode (nodeData) {
    let object;

    if (nodeData.isMesh && nodeData.meshData) {
        object = reconstructMesh (nodeData.meshData);
    } else {
        object = new THREE.Group ();
    }

    object.name = nodeData.name || '';

    // Apply matrix
    if (nodeData.matrix) {
        let matrix = new THREE.Matrix4 ();
        matrix.fromArray (nodeData.matrix);
        object.applyMatrix4 (matrix);
    }

    object.matrixAutoUpdate = false;

    // Recurse children
    for (let childData of nodeData.children) {
        let childObject = reconstructNode (childData);
        object.add (childObject);
    }

    return object;
}

export function ReconstructThreeGroup (data) {
    if (!data || !data.hierarchy) {
        return null;
    }
    return reconstructNode (data.hierarchy);
}
