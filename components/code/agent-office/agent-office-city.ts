import * as THREE from "three"

import type { OfficeTimeOfDay } from "@/lib/agent-office-environment"

export type EdgeDistrictVariant = "full" | "thumbnail"

export type EdgeDistrictLight = {
  background: number
  fog: number
  horizon: number
}

export type EdgeDistrictCounts = {
  buildings: number
  secondaryBuildings: number
  windows: number
  trees: number
  vehicles: number
  expectedDrawCalls: number
}

export type EdgeDistrictFraming = {
  target: THREE.Vector3
  yaw: number
  pitch: number
  distance: number
  landscapeDistance: number
  portraitDistance: number
  minDistance: number
  maxDistance: number
  groundY: number
  officeY: number
  districtWidth: number
  districtDepth: number
}

export type EdgeDistrictResult = {
  oceanGeometry: THREE.PlaneGeometry
  oceanPosition: THREE.BufferAttribute
  oceanBase: Float32Array
  beacon: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  vehicleMesh: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
  animateVehicles: (elapsedSeconds: number) => void
  counts: EdgeDistrictCounts
  framing: EdgeDistrictFraming
}

export type AddEdgeDistrictOptions = {
  scene: THREE.Scene
  totalWidth: number
  totalDepth: number
  timeOfDay: OfficeTimeOfDay
  light: EdgeDistrictLight
  variant: EdgeDistrictVariant
}

type BoxInstance = {
  position: [number, number, number]
  scale: [number, number, number]
  color: number
  rotation?: [number, number, number]
}

type PlaneInstance = {
  position: [number, number, number]
  scale: [number, number]
  color: number
  rotation?: [number, number, number]
}

type Building = {
  x: number
  z: number
  width: number
  depth: number
  height: number
  color: number
}

type VehicleRoute = {
  axis: "x" | "z"
  lane: number
  min: number
  max: number
  speed: number
  phase: number
  direction: 1 | -1
  scale: [number, number, number]
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1)

function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function setInstanceTransform(
  mesh: THREE.InstancedMesh,
  index: number,
  position: [number, number, number],
  scale: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
) {
  const dummy = new THREE.Object3D()
  dummy.position.set(...position)
  dummy.rotation.set(...rotation)
  dummy.scale.set(...scale)
  dummy.updateMatrix()
  mesh.setMatrixAt(index, dummy.matrix)
}

function createBoxInstances(
  instances: BoxInstance[],
  material: THREE.MeshStandardMaterial,
) {
  const mesh = new THREE.InstancedMesh(UNIT_BOX.clone(), material, instances.length)
  instances.forEach((instance, index) => {
    setInstanceTransform(
      mesh,
      index,
      instance.position,
      instance.scale,
      instance.rotation,
    )
    mesh.setColorAt(index, new THREE.Color(instance.color))
  })
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  return mesh
}

function createPlaneInstances(
  instances: PlaneInstance[],
  material: THREE.Material,
) {
  const mesh = new THREE.InstancedMesh(UNIT_PLANE.clone(), material, instances.length)
  instances.forEach((instance, index) => {
    setInstanceTransform(
      mesh,
      index,
      instance.position,
      [instance.scale[0], instance.scale[1], 1],
      instance.rotation,
    )
    mesh.setColorAt(index, new THREE.Color(instance.color))
  })
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  return mesh
}

function createHorizontalPrism(points: Array<[number, number]>, height: number) {
  const positions: number[] = []
  for (const [x, z] of points) positions.push(x, -height / 2, z)
  for (const [x, z] of points) positions.push(x, height / 2, z)

  const count = points.length
  const indices: number[] = []
  for (let index = 1; index < count - 1; index += 1) {
    indices.push(0, index + 1, index)
    indices.push(count, count + index, count + index + 1)
  }
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count
    indices.push(index, next, count + next)
    indices.push(index, count + next, count + index)
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

function addGlassStrip(
  instances: PlaneInstance[],
  props: BoxInstance[],
  start: [number, number],
  end: [number, number],
  height: number,
  centerY: number,
  maxPanelWidth: number,
  glassColor: number,
  mullionColor: number,
) {
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  const length = Math.hypot(dx, dz)
  const panels = Math.max(1, Math.ceil(length / maxPanelWidth))
  const panelWidth = length / panels
  const rotationY = Math.atan2(-dz, dx)

  for (let index = 0; index < panels; index += 1) {
    const progress = (index + 0.5) / panels
    instances.push({
      position: [
        start[0] + dx * progress,
        centerY,
        start[1] + dz * progress,
      ],
      scale: [Math.max(0.08, panelWidth - 0.07), height],
      color: glassColor,
      rotation: [0, rotationY, 0],
    })
  }

  for (let index = 0; index <= panels; index += 1) {
    const progress = index / panels
    props.push({
      position: [
        start[0] + dx * progress,
        centerY,
        start[1] + dz * progress,
      ],
      scale: [0.065, height + 0.08, 0.065],
      color: mullionColor,
    })
  }
}

function addFacadeWindows(
  instances: PlaneInstance[],
  building: Building,
  groundY: number,
  variant: EdgeDistrictVariant,
  random: () => number,
  night: boolean,
) {
  const columnLimit = variant === "thumbnail" ? 3 : 5
  const rowLimit = variant === "thumbnail" ? 4 : 7
  const columns = Math.max(2, Math.min(columnLimit, Math.floor(building.width / 2)))
  const rows = Math.max(2, Math.min(rowLimit, Math.floor(building.height / 1.75)))
  const usableWidth = building.width * 0.72
  const bottom = groundY + Math.min(1.1, building.height * 0.16)
  const usableHeight = Math.max(1.4, building.height - (bottom - groundY) - 0.7)
  const windowWidth = Math.min(1.15, usableWidth / columns * 0.58)
  const windowHeight = Math.min(0.72, usableHeight / rows * 0.52)
  const dayColors = [0x92c9dc, 0xa9d8e7, 0x78aec5]
  const nightColors = [0xffcf78, 0xffe6a8, 0x87c9df, 0x43657c]

  for (let row = 0; row < rows; row += 1) {
    const y = bottom + ((row + 0.5) / rows) * usableHeight
    for (let column = 0; column < columns; column += 1) {
      const x =
        building.x -
        usableWidth / 2 +
        ((column + 0.5) / columns) * usableWidth
      const color = night
        ? nightColors[Math.floor(random() * nightColors.length)]
        : dayColors[Math.floor(random() * dayColors.length)]
      instances.push({
        position: [x, y, building.z + building.depth / 2 + 0.012],
        scale: [windowWidth, windowHeight],
        color,
      })
    }
  }

  const sideColumns = Math.max(1, Math.min(columnLimit - 1, Math.floor(building.depth / 2.4)))
  for (let row = 0; row < rows; row += 1) {
    const y = bottom + ((row + 0.5) / rows) * usableHeight
    for (let column = 0; column < sideColumns; column += 1) {
      const z =
        building.z -
        building.depth * 0.34 +
        ((column + 0.5) / sideColumns) * building.depth * 0.68
      const color = night
        ? nightColors[Math.floor(random() * nightColors.length)]
        : dayColors[Math.floor(random() * dayColors.length)]
      instances.push({
        position: [building.x - building.width / 2 - 0.012, y, z],
        scale: [Math.min(1.05, building.depth / sideColumns * 0.48), windowHeight],
        color,
        rotation: [0, Math.PI / 2, 0],
      })
    }
  }
}

export function addEdgeDistrict({
  scene,
  totalWidth,
  totalDepth,
  timeOfDay,
  light,
  variant,
}: AddEdgeDistrictOptions): EdgeDistrictResult {
  const night = timeOfDay === "night"
  const random = seededRandom(
    0x5eeda11 + Math.round(totalWidth * 17) + Math.round(totalDepth * 29) + (variant === "full" ? 101 : 7),
  )
  const groundY = -13.4
  const officeY = 0
  const districtHalfWidth = Math.max(58, totalWidth + 28)
  const districtHalfDepth = Math.max(44, totalDepth + 25)

  scene.background = new THREE.Color(light.background)
  scene.fog = new THREE.Fog(light.fog, 64, 205)

  const horizon = new THREE.Mesh(
    new THREE.PlaneGeometry(districtHalfWidth * 3.8, 92),
    new THREE.MeshBasicMaterial({ color: light.horizon, fog: false }),
  )
  horizon.position.set(0, 23, -districtHalfDepth - 112)
  horizon.renderOrder = -20
  horizon.userData.agentOfficeEnvironment = "edge-district"
  scene.add(horizon)

  const oceanGeometry = new THREE.PlaneGeometry(
    districtHalfWidth * 3.5,
    138,
    variant === "full" ? 42 : 20,
    variant === "full" ? 22 : 10,
  )
  const oceanPosition = oceanGeometry.attributes.position as THREE.BufferAttribute
  const oceanBase = new Float32Array(oceanPosition.count)
  for (let index = 0; index < oceanPosition.count; index += 1) {
    oceanBase[index] = oceanPosition.getY(index)
  }
  const ocean = new THREE.Mesh(
    oceanGeometry,
    new THREE.MeshStandardMaterial({
      color: night ? 0x0b4565 : 0x1e89ac,
      roughness: night ? 0.34 : 0.24,
      metalness: 0.34,
      emissive: night ? 0x04243a : 0x062b39,
      emissiveIntensity: night ? 0.52 : 0.1,
    }),
  )
  ocean.rotation.x = -Math.PI / 2
  ocean.position.set(0, groundY - 0.18, -districtHalfDepth - 67)
  ocean.renderOrder = -5
  ocean.userData.agentOfficeEnvironment = "edge-district"
  scene.add(ocean)

  const cityGround = new THREE.Mesh(
    new THREE.PlaneGeometry(districtHalfWidth * 2.1, districtHalfDepth * 2.05),
    new THREE.MeshStandardMaterial({
      color: night ? 0x26343b : 0x9ca8a5,
      roughness: 0.94,
      metalness: 0.02,
    }),
  )
  cityGround.rotation.x = -Math.PI / 2
  cityGround.position.y = groundY - 0.04
  cityGround.receiveShadow = false
  cityGround.userData.agentOfficeEnvironment = "edge-district"
  scene.add(cityGround)

  const roadInstances: PlaneInstance[] = []
  const roadColor = night ? 0x17242c : 0x3d4a50
  const plazaColor = night ? 0x465359 : 0xc5cbc7
  const markingColor = night ? 0xd7d69c : 0xe8e3c8
  const frontBoulevardZ = totalDepth / 2 + 13
  const backBoulevardZ = -totalDepth / 2 - 15
  const westRoadX = -totalWidth / 2 - 11
  const eastRoadX = totalWidth / 2 + 11

  roadInstances.push(
    {
      position: [0, groundY + 0.015, frontBoulevardZ],
      scale: [districtHalfWidth * 2.04, 7.2],
      color: roadColor,
      rotation: [-Math.PI / 2, 0, 0],
    },
    {
      position: [0, groundY + 0.015, backBoulevardZ],
      scale: [districtHalfWidth * 2.04, 6.4],
      color: roadColor,
      rotation: [-Math.PI / 2, 0, 0],
    },
    {
      position: [westRoadX, groundY + 0.018, 0],
      scale: [6.4, districtHalfDepth * 2],
      color: roadColor,
      rotation: [-Math.PI / 2, 0, Math.PI / 2],
    },
    {
      position: [eastRoadX, groundY + 0.018, 0],
      scale: [6.4, districtHalfDepth * 2],
      color: roadColor,
      rotation: [-Math.PI / 2, 0, Math.PI / 2],
    },
    {
      position: [0, groundY + 0.02, -totalDepth / 2 - 8],
      scale: [Math.min(25, totalWidth * 0.7), 9],
      color: plazaColor,
      rotation: [-Math.PI / 2, 0, 0],
    },
  )

  for (const z of [frontBoulevardZ - 1.4, frontBoulevardZ + 1.4, backBoulevardZ]) {
    roadInstances.push({
      position: [0, groundY + 0.035, z],
      scale: [districtHalfWidth * 1.98, 0.11],
      color: markingColor,
      rotation: [-Math.PI / 2, 0, 0],
    })
  }
  for (const x of [westRoadX, eastRoadX]) {
    roadInstances.push({
      position: [x, groundY + 0.037, 0],
      scale: [districtHalfDepth * 1.94, 0.11],
      color: markingColor,
      rotation: [-Math.PI / 2, 0, Math.PI / 2],
    })
  }

  const roads = createPlaneInstances(
    roadInstances,
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0.01,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }),
  )
  roads.userData.agentOfficeEnvironment = "edge-district"
  scene.add(roads)

  const structureInstances: BoxInstance[] = []
  const propInstances: BoxInstance[] = []
  const facadeWindows: PlaneInstance[] = []
  const rooftopGlass: PlaneInstance[] = []
  const treeInstances: BoxInstance[] = []

  const landmarkDark = night ? 0x182c3a : 0x3f6d80
  const landmarkMid = night ? 0x1d3a4b : 0x5b8da0
  const landmarkLight = night ? 0x25475a : 0x79a9b8
  const lowerHeight = 3.8
  const middleBottom = groundY + 3
  const middleTop = -2.35
  const upperBottom = -3.05
  const upperTop = -0.22
  const lowerWidth = totalWidth + 14
  const lowerDepth = totalDepth + 14
  const middleWidth = totalWidth + 10
  const middleDepth = totalDepth + 10
  const upperWidth = totalWidth + 7
  const upperDepth = totalDepth + 7

  structureInstances.push(
    {
      position: [0, groundY + lowerHeight / 2, 0],
      scale: [lowerWidth, lowerHeight, lowerDepth],
      color: landmarkDark,
    },
    {
      position: [0, (middleBottom + middleTop) / 2, -0.35],
      scale: [middleWidth, middleTop - middleBottom, middleDepth],
      color: landmarkMid,
    },
    {
      position: [0, (upperBottom + upperTop) / 2, -0.72],
      scale: [upperWidth, upperTop - upperBottom, upperDepth],
      color: landmarkLight,
    },
  )

  const secondaryCount = variant === "full" ? 16 : 7
  const normalizedLots: Array<[number, number]> = [
    [-0.54, -0.64],
    [0, -0.76],
    [0.54, -0.64],
    [-0.82, -0.34],
    [0.82, -0.34],
    [-0.88, 0.02],
    [0.88, 0.02],
    [-0.82, 0.46],
    [0.82, 0.46],
    [-0.52, 0.7],
    [0.52, 0.7],
    [-0.64, -0.02],
    [0.64, -0.02],
    [-0.58, 0.32],
    [0.58, 0.32],
    [0, -0.96],
    [-0.96, -0.58],
    [0.96, -0.58],
  ]
  const dayBuildingColors = [0x8799a0, 0x6f8c98, 0x9ba8a8, 0x58778a, 0xb0aaa0]
  const nightBuildingColors = [0x1c2a34, 0x213644, 0x2a3b45, 0x172c3b, 0x354047]
  const secondaryBuildings: Building[] = []

  for (let index = 0; index < secondaryCount; index += 1) {
    const [normalizedX, normalizedZ] = normalizedLots[index]
    const width = 6.2 + random() * 5.4
    const depth = 6 + random() * 5.2
    const foregroundPenalty = normalizedZ > 0.2 ? 2.8 : 0
    const height = Math.max(5.2, 7.4 + random() * 5.4 - foregroundPenalty)
    const x = normalizedX * districtHalfWidth + (random() - 0.5) * 2.2
    const z = normalizedZ * districtHalfDepth + (random() - 0.5) * 2
    const palette = night ? nightBuildingColors : dayBuildingColors
    const building: Building = {
      x,
      z,
      width,
      depth,
      height,
      color: palette[Math.floor(random() * palette.length)],
    }
    secondaryBuildings.push(building)
    structureInstances.push({
      position: [x, groundY + height / 2, z],
      scale: [width, height, depth],
      color: building.color,
      rotation: [0, (random() - 0.5) * 0.08, 0],
    })
    if (index % 3 === 0) {
      const crownHeight = 0.42 + random() * 0.38
      structureInstances.push({
        position: [x, groundY + height + crownHeight / 2, z],
        scale: [width * 0.58, crownHeight, depth * 0.58],
        color: night ? 0x315164 : 0xb7c8cb,
      })
    }
    propInstances.push({
      position: [
        x + width * 0.31,
        groundY + height * 0.54,
        z + depth / 2 + 0.06,
      ],
      scale: [0.13, height * 0.74, 0.12],
      color: night ? 0x69d7ed : 0xd1eef3,
    })
    addFacadeWindows(facadeWindows, building, groundY, variant, random, night)
  }

  const landmarkFacade: Building = {
    x: 0,
    z: -0.72,
    width: upperWidth,
    depth: upperDepth,
    height: upperTop - groundY,
    color: landmarkLight,
  }
  addFacadeWindows(facadeWindows, landmarkFacade, groundY, variant, random, night)

  const structureMesh = createBoxInstances(
    structureInstances,
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: night ? 0.25 : 0.32,
      metalness: 0.38,
    }),
  )
  structureMesh.userData.agentOfficeEnvironment = "edge-district"
  scene.add(structureMesh)

  const facadeMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: night ? 0.94 : 0.7,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  facadeMaterial.forceSinglePass = true
  const facadeMesh = createPlaneInstances(facadeWindows, facadeMaterial)
  facadeMesh.renderOrder = 2
  facadeMesh.userData.agentOfficeEnvironment = "edge-district"
  scene.add(facadeMesh)

  const atriumHeight = upperTop - groundY - 1.2
  const atriumWidth = Math.max(4.2, Math.min(7.4, totalWidth * 0.22))
  const atrium = new THREE.Mesh(
    new THREE.BoxGeometry(atriumWidth, atriumHeight, 0.38),
    new THREE.MeshPhysicalMaterial({
      color: night ? 0x63d6f2 : 0x9ce3f3,
      emissive: night ? 0x177d9b : 0x1a7185,
      emissiveIntensity: night ? 1.12 : 0.22,
      roughness: 0.08,
      metalness: 0.18,
      clearcoat: 0.82,
      clearcoatRoughness: 0.12,
      transparent: true,
      opacity: night ? 0.76 : 0.56,
      depthWrite: false,
    }),
  )
  atrium.position.set(0, groundY + 0.6 + atriumHeight / 2, upperDepth / 2 - 0.52)
  atrium.renderOrder = 4
  atrium.userData.agentOfficeEnvironment = "edge-district"
  scene.add(atrium)

  const deckWidth = totalWidth + 8
  const deckInnerZ = totalDepth / 2 + 1.1
  const deckOuterZ = totalDepth / 2 + 7
  const deckPoints: Array<[number, number]> = [
    [-deckWidth / 2, deckInnerZ],
    [deckWidth / 2, deckInnerZ],
    [deckWidth / 2 + 1.1, deckOuterZ - 0.7],
    [0, deckOuterZ + 2.8],
    [-deckWidth / 2 - 1.1, deckOuterZ - 0.7],
  ]
  const skyDeck = new THREE.Mesh(
    createHorizontalPrism(deckPoints, 0.3),
    new THREE.MeshStandardMaterial({
      color: night ? 0x78858c : 0xe2e8e7,
      roughness: 0.5,
      metalness: 0.18,
    }),
  )
  skyDeck.position.y = -0.27
  skyDeck.receiveShadow = variant === "full"
  skyDeck.userData.agentOfficeEnvironment = "edge-district"
  scene.add(skyDeck)

  const glassColor = night ? 0x5dbbd6 : 0xb0e0eb
  const mullionColor = night ? 0x263f4e : 0x647c87
  addGlassStrip(
    rooftopGlass,
    propInstances,
    [-totalWidth / 2 - 2, -totalDepth / 2 - 1.08],
    [totalWidth / 2 + 2, -totalDepth / 2 - 1.08],
    3.85,
    1.925,
    2.8,
    glassColor,
    mullionColor,
  )
  addGlassStrip(
    rooftopGlass,
    propInstances,
    [-totalWidth / 2 - 1.08, -totalDepth / 2 - 1],
    [-totalWidth / 2 - 1.08, totalDepth / 2 + 1.5],
    3.85,
    1.925,
    2.8,
    glassColor,
    mullionColor,
  )
  addGlassStrip(
    rooftopGlass,
    propInstances,
    [totalWidth / 2 + 1.08, -totalDepth / 2 - 1],
    [totalWidth / 2 + 1.08, totalDepth / 2 + 1.5],
    3.85,
    1.925,
    2.8,
    glassColor,
    mullionColor,
  )
  for (let index = 1; index < deckPoints.length - 1; index += 1) {
    addGlassStrip(
      rooftopGlass,
      propInstances,
      deckPoints[index],
      deckPoints[index + 1],
      1.08,
      0.6,
      3,
      glassColor,
      mullionColor,
    )
  }
  addGlassStrip(
    rooftopGlass,
    propInstances,
    deckPoints[deckPoints.length - 1],
    deckPoints[0],
    1.08,
    0.6,
    3,
    glassColor,
    mullionColor,
  )

  const rooftopGlassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.1,
    metalness: 0.14,
    clearcoat: 0.72,
    clearcoatRoughness: 0.15,
    transparent: true,
    opacity: night ? 0.5 : 0.3,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  rooftopGlassMaterial.forceSinglePass = true
  const rooftopGlassMesh = createPlaneInstances(rooftopGlass, rooftopGlassMaterial)
  rooftopGlassMesh.renderOrder = 5
  rooftopGlassMesh.userData.agentOfficeEnvironment = "edge-district"
  scene.add(rooftopGlassMesh)

  const atriumFinHeight = atriumHeight + 0.25
  for (const side of [-1, 1]) {
    propInstances.push({
      position: [
        side * (atriumWidth / 2 + 0.08),
        groundY + 0.6 + atriumHeight / 2,
        upperDepth / 2 - 0.28,
      ],
      scale: [0.12, atriumFinHeight, 0.18],
      color: mullionColor,
      rotation: [0, 0, side * -0.055],
    })
  }

  const canopyWidth = Math.min(totalWidth * 0.52, 17)
  const canopyPanels = variant === "full" ? 5 : 3
  for (let index = 0; index < canopyPanels; index += 1) {
    const panelWidth = canopyWidth / canopyPanels - 0.08
    propInstances.push({
      position: [
        -canopyWidth / 2 + panelWidth / 2 + index * (canopyWidth / canopyPanels),
        4.12,
        -totalDepth / 2 + 0.55,
      ],
      scale: [panelWidth, 0.14, 3.25],
      color: night ? 0x203746 : 0x244e63,
      rotation: [-0.055, 0, 0],
    })
  }

  const rooftopPlanters: Array<[number, number]> = [
    [-totalWidth / 2 - 0.3, totalDepth / 2 + 2.7],
    [totalWidth / 2 + 0.3, totalDepth / 2 + 2.7],
    [-totalWidth / 2 - 0.25, -totalDepth / 2 + 0.25],
    [totalWidth / 2 + 0.25, -totalDepth / 2 + 0.25],
  ]
  for (const [x, z] of rooftopPlanters) {
    propInstances.push({
      position: [x, 0.24, z],
      scale: [0.78, 0.48, 0.78],
      color: night ? 0x627078 : 0xe1e7e4,
    })
    treeInstances.push({
      position: [x, 1.3, z],
      scale: [0.48, 0.68, 0.48],
      color: night ? 0x28604e : 0x2f7d5c,
    })
  }
  for (const x of [-2.3, 2.3]) {
    propInstances.push({
      position: [x, 0.27, totalDepth / 2 + 2.45],
      scale: [2.45, 0.45, 0.82],
      color: night ? 0x29404d : 0xf2f4f1,
    })
  }

  const urbanTreeCount = variant === "full" ? 22 : 10
  for (let index = 0; index < urbanTreeCount; index += 1) {
    const side = index % 2 === 0 ? -1 : 1
    const row = Math.floor(index / 2)
    const x =
      side * (totalWidth / 2 + 17 + (row % 3) * 4.2) +
      (random() - 0.5) * 1.2
    const z =
      -totalDepth / 2 -
      7 +
      (row % Math.max(3, Math.ceil(urbanTreeCount / 5))) * 4.1 +
      (random() - 0.5)
    propInstances.push({
      position: [x, groundY + 0.55, z],
      scale: [0.13, 1.1, 0.13],
      color: 0x684b36,
    })
    treeInstances.push({
      position: [x, groundY + 1.6, z],
      scale: [0.7, 0.92, 0.7],
      color: night ? 0x245945 : 0x347d57,
    })
  }

  const propsMesh = createBoxInstances(
    propInstances,
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.58,
      metalness: 0.2,
    }),
  )
  propsMesh.userData.agentOfficeEnvironment = "edge-district"
  scene.add(propsMesh)

  const trees = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, variant === "full" ? 1 : 0),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.86,
      metalness: 0,
    }),
    treeInstances.length,
  )
  treeInstances.forEach((instance, index) => {
    setInstanceTransform(
      trees,
      index,
      instance.position,
      instance.scale,
      instance.rotation,
    )
    trees.setColorAt(index, new THREE.Color(instance.color))
  })
  trees.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  if (trees.instanceColor) trees.instanceColor.needsUpdate = true
  trees.frustumCulled = false
  trees.castShadow = false
  trees.receiveShadow = false
  trees.userData.agentOfficeEnvironment = "edge-district"
  scene.add(trees)

  const vehicleCount = variant === "full" ? 10 : 4
  const vehicleRoutes: VehicleRoute[] = []
  for (let index = 0; index < vehicleCount; index += 1) {
    const horizontal = index < Math.ceil(vehicleCount * 0.6)
    if (horizontal) {
      vehicleRoutes.push({
        axis: "x",
        lane: frontBoulevardZ + (index % 2 === 0 ? -1.65 : 1.65),
        min: -districtHalfWidth + 4,
        max: districtHalfWidth - 4,
        speed: 3.4 + random() * 2.3,
        phase: random(),
        direction: index % 2 === 0 ? 1 : -1,
        scale: [1.45, 0.36, 0.68],
      })
    } else {
      vehicleRoutes.push({
        axis: "z",
        lane: index % 2 === 0 ? westRoadX - 1.45 : eastRoadX + 1.45,
        min: -districtHalfDepth + 4,
        max: districtHalfDepth - 4,
        speed: 2.9 + random() * 2.1,
        phase: random(),
        direction: index % 2 === 0 ? 1 : -1,
        scale: [1.45, 0.36, 0.68],
      })
    }
  }

  const vehicleMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.38,
    metalness: 0.44,
  })
  const vehicleMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    vehicleMaterial,
    vehicleRoutes.length,
  )
  const vehicleColors = night
    ? [0xffcf67, 0xc5d9e8, 0x55b7d4, 0xe3695d]
    : [0xf3f4f4, 0x254f68, 0xd8564b, 0xe0a63b]
  vehicleRoutes.forEach((_, index) => {
    vehicleMesh.setColorAt(index, new THREE.Color(vehicleColors[index % vehicleColors.length]))
  })
  if (vehicleMesh.instanceColor) vehicleMesh.instanceColor.needsUpdate = true
  vehicleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  vehicleMesh.frustumCulled = false
  vehicleMesh.castShadow = false
  vehicleMesh.userData.agentOfficeEnvironment = "edge-district"
  scene.add(vehicleMesh)

  const vehicleDummy = new THREE.Object3D()
  const animateVehicles = (elapsedSeconds: number) => {
    vehicleRoutes.forEach((route, index) => {
      const span = route.max - route.min
      const travel = route.phase + (elapsedSeconds * route.speed * route.direction) / span
      const progress = ((travel % 1) + 1) % 1
      const position = route.min + progress * span
      vehicleDummy.position.set(
        route.axis === "x" ? position : route.lane,
        groundY + 0.28,
        route.axis === "z" ? position : route.lane,
      )
      vehicleDummy.rotation.set(0, route.axis === "z" ? Math.PI / 2 : 0, 0)
      vehicleDummy.scale.set(...route.scale)
      vehicleDummy.updateMatrix()
      vehicleMesh.setMatrixAt(index, vehicleDummy.matrix)
    })
    vehicleMesh.instanceMatrix.needsUpdate = true
  }
  animateVehicles(0)

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(night ? 1.1 : 1.55, 24, 16),
    new THREE.MeshBasicMaterial({
      color: night ? 0xe8f1ff : 0xffefb1,
      fog: false,
    }),
  )
  beacon.position.set(night ? 25 : -29, night ? 20 : 25, -districtHalfDepth - 72)
  beacon.userData.agentOfficeEnvironment = "edge-district"
  scene.add(beacon)

  if (night) {
    const starCount = variant === "full" ? 150 : 55
    const starPositions = new Float32Array(starCount * 3)
    for (let index = 0; index < starCount; index += 1) {
      starPositions[index * 3] = (random() - 0.5) * districtHalfWidth * 3
      starPositions[index * 3 + 1] = 7 + random() * 39
      starPositions[index * 3 + 2] = -districtHalfDepth - 36 - random() * 95
    }
    const starGeometry = new THREE.BufferGeometry()
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3))
    const stars = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({
        color: 0xdceaff,
        size: 0.17,
        transparent: true,
        opacity: 0.82,
        fog: false,
      }),
    )
    stars.userData.agentOfficeEnvironment = "edge-district"
    scene.add(stars)
  }

  const baseDistance =
    variant === "thumbnail"
      ? Math.max(42, totalWidth * 1.2, totalDepth * 1.55)
      : Math.max(48, totalWidth * 1.35, totalDepth * 1.7)
  const landscapeDistance = variant === "thumbnail" ? baseDistance * 0.93 : baseDistance
  const portraitDistance = landscapeDistance * 1.52

  return {
    oceanGeometry,
    oceanPosition,
    oceanBase,
    beacon,
    vehicleMesh,
    animateVehicles,
    counts: {
      buildings: secondaryCount + 1,
      secondaryBuildings: secondaryCount,
      windows: facadeWindows.length,
      trees: treeInstances.length,
      vehicles: vehicleRoutes.length,
      expectedDrawCalls: night ? 14 : 13,
    },
    framing: {
      target: new THREE.Vector3(
        0,
        variant === "thumbnail" ? -2.7 : -3.6,
        -totalDepth * 0.1,
      ),
      yaw: -0.72,
      pitch: variant === "thumbnail" ? 0.64 : 0.52,
      distance: landscapeDistance,
      landscapeDistance,
      portraitDistance,
      minDistance: 18,
      maxDistance: 132,
      groundY,
      officeY,
      districtWidth: districtHalfWidth * 2,
      districtDepth: districtHalfDepth * 2,
    },
  }
}
