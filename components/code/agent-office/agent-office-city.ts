import * as THREE from "three"

import type {
  OfficeTimeOfDay,
  OfficeTimePhase,
} from "@/lib/agent-office-environment"

export type EdgeDistrictVariant = "full" | "thumbnail"

export type EdgeDistrictLight = {
  background: number
  fog: number
  horizon: number
}

export type EdgeDistrictCounts = {
  buildings: number
  secondaryBuildings: number
  signatureTowers: number
  architecturalCrowns: number
  glassFacades: number
  terraceAmenities: number
  tallestBuildingHeight: number
  windows: number
  trees: number
  vehicles: number
  lightFixtures: number
  expectedDrawCalls: number
  hqStackedFloors: number
  hqFloorHeight: number
}

export const HQ_FLOOR_TO_FLOOR = 3.85
export const HQ_SLAB_THICKNESS = 0.22
export const HQ_STACKED_FLOORS_FULL = 120
export const HQ_STACKED_FLOORS_THUMBNAIL = 48

export function hqStackedFloorCount(variant: EdgeDistrictVariant): number {
  return variant === "full" ? HQ_STACKED_FLOORS_FULL : HQ_STACKED_FLOORS_THUMBNAIL
}

export type EdgeDistrictFraming = {
  target: THREE.Vector3
  yaw: number
  pitch: number
  portraitPitch: number
  portraitTargetLift: number
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
  timePhase?: OfficeTimePhase
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
  material: THREE.Material,
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

function createCylinderInstances(
  instances: BoxInstance[],
  material: THREE.Material,
) {
  const geometry = new THREE.CylinderGeometry(0.72, 1, 1, 8, 1, false)
  const mesh = new THREE.InstancedMesh(geometry, material, instances.length)
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
  const columnLimit = variant === "thumbnail" ? 4 : 8
  const rowCap =
    variant === "thumbnail"
      ? 6
      : Math.min(28, Math.max(10, Math.floor(Math.sqrt(building.height) * 1.35)))
  const columns = Math.max(2, Math.min(columnLimit, Math.floor(building.width / 2)))
  const rows = Math.max(2, Math.min(rowCap, Math.floor(building.height / 1.75)))
  const usableWidth = building.width * 0.72
  const bottom = groundY + Math.min(1.1, building.height * 0.16)
  const usableHeight = Math.max(1.4, building.height - (bottom - groundY) - 0.7)
  const windowWidth = Math.min(1.05, usableWidth / columns * 0.7)
  const windowHeight = Math.min(0.64, usableHeight / rows * 0.58)
  // Deep blue curtain-wall glass by day; at night warm desks + cool monitors.
  const dayColors = [0x4a7fa8, 0x3a6e98, 0x5a8eb8, 0x2e6288, 0x457aa0]
  const nightLitWarm = [0xffd28a, 0xffe7b2, 0xf6c978, 0xffefc4]
  const nightLitCool = [0x7ed4ef, 0x9be4f4, 0xb5eef8, 0x6bc6e3]
  const nightDarkColors = [0x1a3342, 0x142833, 0x0f1f2a, 0x1c3848]
  const agentSilhouette = 0x0a1218

  const sampleWindow = (row: number): { color: number; lit: boolean } => {
    if (!night) {
      return { color: dayColors[Math.floor(random() * dayColors.length)], lit: false }
    }
    const occupancyBias = row < 2 ? 0.55 : row >= rows - 2 ? 0.28 : 0.22
    const lit = random() > occupancyBias
    if (!lit) {
      return {
        color: nightDarkColors[Math.floor(random() * nightDarkColors.length)],
        lit: false,
      }
    }
    const executiveFloor = row >= rows - 2
    const color = executiveFloor
      ? nightLitCool[Math.floor(random() * nightLitCool.length)]
      : random() > 0.42
        ? nightLitWarm[Math.floor(random() * nightLitWarm.length)]
        : nightLitCool[Math.floor(random() * nightLitCool.length)]
    return { color, lit: true }
  }

  for (let row = 0; row < rows; row += 1) {
    const y = bottom + ((row + 0.5) / rows) * usableHeight
    for (let column = 0; column < columns; column += 1) {
      const x =
        building.x -
        usableWidth / 2 +
        ((column + 0.5) / columns) * usableWidth
      const sample = sampleWindow(row)
      instances.push({
        position: [x, y, building.z + building.depth / 2 + 0.012],
        scale: [windowWidth, windowHeight],
        color: sample.color,
      })
      if (sample.lit && random() > 0.72) {
        instances.push({
          position: [
            x - windowWidth * 0.18,
            y - windowHeight * 0.12,
            building.z + building.depth / 2 + 0.02,
          ],
          scale: [windowWidth * 0.16, windowHeight * 0.42],
          color: agentSilhouette,
        })
        if (random() > 0.72) {
          instances.push({
            position: [
              x + windowWidth * 0.2,
              y - windowHeight * 0.18,
              building.z + building.depth / 2 + 0.02,
            ],
            scale: [windowWidth * 0.12, windowHeight * 0.28],
            color: agentSilhouette,
          })
        }
      }
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
      const sample = sampleWindow(row)
      instances.push({
        position: [building.x - building.width / 2 - 0.012, y, z],
        scale: [Math.min(1.05, building.depth / sideColumns * 0.48), windowHeight],
        color: sample.color,
        rotation: [0, Math.PI / 2, 0],
      })
    }
  }
}

type HqStackedResult = {
  shaftWidth: number
  shaftDepth: number
  lobbyWidth: number
  lobbyDepth: number
  crownWidth: number
  crownDepth: number
  upperTop: number
  landmarkTotalHeight: number
}

function addHqStackedOfficeFloors({
  structureInstances,
  propInstances,
  districtGlassFacades,
  facadeWindows,
  stackedFloors,
  totalWidth,
  totalDepth,
  groundY,
  night,
  variant,
  random,
}: {
  structureInstances: BoxInstance[]
  propInstances: BoxInstance[]
  districtGlassFacades: PlaneInstance[]
  facadeWindows: PlaneInstance[]
  stackedFloors: number
  totalWidth: number
  totalDepth: number
  groundY: number
  night: boolean
  variant: EdgeDistrictVariant
  random: () => number
}): HqStackedResult {
  const shaftWidth = Math.max(16, totalWidth * 0.4)
  const shaftDepth = Math.max(14, totalDepth * 0.4)
  const crownTargetWidth = totalWidth * 0.92
  const crownTargetDepth = totalDepth * 0.92
  const crownCount = Math.max(2, Math.ceil(stackedFloors * 0.06))
  const lobbyCount = Math.max(2, Math.ceil(stackedFloors * 0.03))
  const upperTop = -0.22
  const landmarkTotalHeight = stackedFloors * HQ_FLOOR_TO_FLOOR + 4.2

  const dayGlass = [0x4a7fa8, 0x3a6e98, 0x5a8eb8, 0x2e6288]
  const nightGlass = [0x163a58, 0x1a4568, 0x205078, 0x123048]
  const glassPalette = night ? nightGlass : dayGlass
  const steelDark = night ? 0x142838 : 0x1a3548
  const steelMid = night ? 0x1e4058 : 0x2a5068
  const steelLight = night ? 0x2a5878 : 0x3a6a88
  const slabColor = night ? 0x1a3040 : 0x2e4858
  const spandrelColor = night ? 0x243848 : 0x3a5568
  const interiorColor = night ? 0x0e1c28 : 0x1a2e3c
  const deskColor = night ? 0x3a4a55 : 0x6a7a85
  const chairColor = night ? 0x1a2830 : 0x2a3840

  let lobbyWidth = shaftWidth * 1.22
  let lobbyDepth = shaftDepth * 1.22
  let crownWidth = crownTargetWidth
  let crownDepth = crownTargetDepth

  const footprintForFloor = (floor: number): { width: number; depth: number } => {
    if (floor <= crownCount) {
      const t = crownCount <= 1 ? 1 : (crownCount - floor) / (crownCount - 1)
      const width = shaftWidth + (crownTargetWidth - shaftWidth) * (0.55 + 0.45 * t)
      const depth = shaftDepth + (crownTargetDepth - shaftDepth) * (0.55 + 0.45 * t)
      return { width, depth }
    }
    if (floor > stackedFloors - lobbyCount) {
      const lobbyIndex = floor - (stackedFloors - lobbyCount)
      const t = lobbyIndex / lobbyCount
      return {
        width: shaftWidth * (1 + 0.22 * t),
        depth: shaftDepth * (1 + 0.22 * t),
      }
    }
    const taper = 0.97 + 0.03 * Math.sin(floor * 0.35)
    return { width: shaftWidth * taper, depth: shaftDepth * taper }
  }

  for (let floor = 1; floor <= stackedFloors; floor += 1) {
    const { width, depth } = footprintForFloor(floor)
    if (floor === 1) {
      crownWidth = width
      crownDepth = depth
    }
    if (floor === stackedFloors) {
      lobbyWidth = width
      lobbyDepth = depth
    }

    const slabY = -floor * HQ_FLOOR_TO_FLOOR + HQ_SLAB_THICKNESS / 2
    const glassHeight = Math.max(0.8, HQ_FLOOR_TO_FLOOR - HQ_SLAB_THICKNESS * 1.15)
    const glassCenterY = -floor * HQ_FLOOR_TO_FLOOR + HQ_FLOOR_TO_FLOOR * 0.52
    const spandrelY = -floor * HQ_FLOOR_TO_FLOOR + HQ_SLAB_THICKNESS + 0.18
    const isCrown = floor <= crownCount
    const isLobby = floor > stackedFloors - lobbyCount
    const glassColor = glassPalette[(floor + (isCrown ? 1 : 0)) % glassPalette.length]
    const frameColor = isCrown ? steelLight : isLobby ? steelMid : steelDark

    structureInstances.push({
      position: [0, slabY, 0],
      scale: [width * 1.02, HQ_SLAB_THICKNESS, depth * 1.02],
      color: slabColor,
    })
    structureInstances.push({
      position: [0, spandrelY, 0],
      scale: [width * 1.015, 0.28, depth * 1.015],
      color: spandrelColor,
    })

    // Thin structural rim (steel frame) per floor — keeps curtain-wall reading.
    structureInstances.push({
      position: [0, glassCenterY, depth / 2 + 0.04],
      scale: [width * 1.01, glassHeight * 0.98, 0.08],
      color: frameColor,
    })
    structureInstances.push({
      position: [0, glassCenterY, -depth / 2 - 0.04],
      scale: [width * 1.01, glassHeight * 0.98, 0.08],
      color: frameColor,
    })
    structureInstances.push({
      position: [width / 2 + 0.04, glassCenterY, 0],
      scale: [0.08, glassHeight * 0.98, depth * 1.01],
      color: frameColor,
    })
    structureInstances.push({
      position: [-width / 2 - 0.04, glassCenterY, 0],
      scale: [0.08, glassHeight * 0.98, depth * 1.01],
      color: frameColor,
    })

    districtGlassFacades.push(
      {
        position: [0, glassCenterY, depth / 2 + 0.055],
        scale: [width * 0.96, glassHeight],
        color: glassColor,
      },
      {
        position: [0, glassCenterY, -depth / 2 - 0.055],
        scale: [width * 0.96, glassHeight],
        color: glassColor,
        rotation: [0, Math.PI, 0],
      },
      {
        position: [width / 2 + 0.055, glassCenterY, 0],
        scale: [depth * 0.96, glassHeight],
        color: glassColor,
        rotation: [0, Math.PI / 2, 0],
      },
      {
        position: [-width / 2 - 0.055, glassCenterY, 0],
        scale: [depth * 0.96, glassHeight],
        color: glassColor,
        rotation: [0, -Math.PI / 2, 0],
      },
    )

    const showInterior = isCrown || isLobby || floor % 4 === 0
    if (showInterior) {
      structureInstances.push({
        position: [0, glassCenterY, 0],
        scale: [width * 0.88, glassHeight * 0.9, depth * 0.88],
        color: interiorColor,
      })
    }

    if (isCrown || isLobby) {
      const deskCount = variant === "full" ? 3 : 2
      for (let desk = 0; desk < deskCount; desk += 1) {
        const dx = (desk - (deskCount - 1) / 2) * Math.min(3.2, width * 0.22)
        propInstances.push(
          {
            position: [dx, slabY + HQ_SLAB_THICKNESS / 2 + 0.38, depth * 0.12],
            scale: [1.4, 0.12, 0.7],
            color: deskColor,
          },
          {
            position: [dx, slabY + HQ_SLAB_THICKNESS / 2 + 0.55, depth * 0.12 + 0.55],
            scale: [0.42, 0.55, 0.42],
            color: chairColor,
          },
        )
      }
    }

    const detailEveryFloor = isCrown || isLobby || floor % 2 === 0
    if (detailEveryFloor) {
      const cols = Math.max(2, Math.min(variant === "full" ? 6 : 4, Math.floor(width / 2.4)))
      const windowW = Math.min(1.1, (width * 0.78) / cols * 0.62)
      const windowH = Math.min(1.35, glassHeight * 0.42)
      for (let column = 0; column < cols; column += 1) {
        const x = -width * 0.36 + ((column + 0.5) / cols) * width * 0.72
        facadeWindows.push({
          position: [x, glassCenterY, depth / 2 + 0.07],
          scale: [windowW, windowH],
          color: glassColor,
        })
      }
      if (variant === "full" && (isCrown || isLobby || floor % 4 === 0)) {
        const sideCols = Math.max(1, Math.min(4, Math.floor(depth / 3)))
        for (let column = 0; column < sideCols; column += 1) {
          const z = -depth * 0.32 + ((column + 0.5) / sideCols) * depth * 0.64
          facadeWindows.push({
            position: [-width / 2 - 0.07, glassCenterY, z],
            scale: [Math.min(1.05, depth / sideCols * 0.45), windowH],
            color: glassColor,
            rotation: [0, Math.PI / 2, 0],
          })
        }
      }
    }

    // Suppress unused-seed jitter so stacked floors stay deterministic per seed.
    if (floor % 17 === 0) random()
  }

  // Crown cap just under the rooftop office plate + lobby podium at grade.
  structureInstances.push({
    position: [0, upperTop - 0.12, 0],
    scale: [crownWidth * 1.04, 0.28, crownDepth * 1.04],
    color: steelLight,
  })
  structureInstances.push({
    position: [0, groundY + 0.45, 0],
    scale: [lobbyWidth * 1.1, 0.9, lobbyDepth * 1.1],
    color: steelMid,
  })

  return {
    shaftWidth,
    shaftDepth,
    lobbyWidth,
    lobbyDepth,
    crownWidth,
    crownDepth,
    upperTop,
    landmarkTotalHeight,
  }
}

function createBrandSign() {
  if (typeof document === "undefined") return null
  const canvas = document.createElement("canvas")
  canvas.width = 1024
  canvas.height = 224
  const context = canvas.getContext("2d")
  if (!context) return null

  context.clearRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = "rgba(8, 18, 29, 0.82)"
  context.beginPath()
  context.roundRect(8, 8, 1008, 208, 24)
  context.fill()
  context.strokeStyle = "rgba(161, 222, 236, 0.7)"
  context.lineWidth = 3
  context.stroke()
  context.fillStyle = "#f8fafc"
  context.font = "700 92px Inter, system-ui, sans-serif"
  context.fillText("SIRA", 58, 116)
  context.fillStyle = "#8dd8e9"
  context.font = "600 34px Inter, system-ui, sans-serif"
  context.fillText("MODERN AGENTS HQ · EACH DESK IS AN AGENT", 58, 172)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 1.62), material)
  sign.renderOrder = 8
  sign.userData.agentOfficeEnvironment = "edge-district"
  return sign
}

export function addEdgeDistrict({
  scene,
  totalWidth,
  totalDepth,
  timeOfDay,
  timePhase,
  light,
  variant,
}: AddEdgeDistrictOptions): EdgeDistrictResult {
  const night = timeOfDay === "night" || timePhase === "dusk"
  const fullNight = timeOfDay === "night"
  const random = seededRandom(
    0x5eeda11 + Math.round(totalWidth * 17) + Math.round(totalDepth * 29) + (variant === "full" ? 101 : 7),
  )
  // Stacked slender HQ: rooftop office stays at y=0; ground drops with floor count.
  const stackedHqFloors = hqStackedFloorCount(variant)
  const groundY = -stackedHqFloors * HQ_FLOOR_TO_FLOOR
  const officeY = 0
  const districtHalfWidth = Math.max(120, totalWidth + 72)
  const districtHalfDepth = Math.max(96, totalDepth + 60)

  scene.background = new THREE.Color(light.background)
  scene.fog = new THREE.Fog(
    light.fog,
    Math.max(140, -groundY * 0.28),
    Math.max(520, -groundY * 1.55),
  )

  const horizonLift = Math.max(25, -groundY * 0.12)
  const horizon = new THREE.Mesh(
    new THREE.PlaneGeometry(districtHalfWidth * 4.1, Math.max(104, -groundY * 0.45)),
    new THREE.MeshBasicMaterial({
      color: light.horizon,
      transparent: true,
      opacity: night ? 0.92 : 0.82,
      fog: false,
    }),
  )
  horizon.position.set(0, horizonLift, -districtHalfDepth - 128)
  horizon.renderOrder = -20
  horizon.userData.agentOfficeEnvironment = "edge-district"
  scene.add(horizon)

  const horizonGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(districtHalfWidth * 3.7, 18),
    new THREE.MeshBasicMaterial({
      color:
        timePhase === "dusk"
          ? 0xc78968
          : fullNight
            ? 0x68594f
            : 0xd8e6ec,
      transparent: true,
      opacity: timePhase === "dusk" ? 0.46 : fullNight ? 0.24 : 0.42,
      depthWrite: false,
      fog: false,
    }),
  )
  horizonGlow.position.set(0, horizonLift * 0.15, -districtHalfDepth - 126)
  horizonGlow.renderOrder = -19
  horizonGlow.userData.agentOfficeEnvironment = "edge-district"
  scene.add(horizonGlow)

  const oceanGeometry = new THREE.PlaneGeometry(
    districtHalfWidth * 4,
    168,
    variant === "full" ? 64 : 32,
    variant === "full" ? 34 : 16,
  )
  const oceanPosition = oceanGeometry.attributes.position as THREE.BufferAttribute
  const oceanBase = new Float32Array(oceanPosition.count)
  for (let index = 0; index < oceanPosition.count; index += 1) {
    oceanBase[index] = oceanPosition.getY(index)
  }
  const ocean = new THREE.Mesh(
    oceanGeometry,
    new THREE.MeshPhysicalMaterial({
      color: night ? 0x0d3a5c : 0x2a8aaa,
      roughness: night ? 0.12 : 0.06,
      metalness: 0.62,
      emissive: night ? 0x052238 : 0x0a4a60,
      emissiveIntensity: night ? 0.72 : 0.1,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      envMapIntensity: 1.2,
    }),
  )
  ocean.rotation.x = -Math.PI / 2
  ocean.position.set(0, groundY - 0.18, -districtHalfDepth - 72)
  ocean.renderOrder = -5
  ocean.userData.agentOfficeEnvironment = "edge-district"
  scene.add(ocean)

  const cityGround = new THREE.Mesh(
    new THREE.PlaneGeometry(districtHalfWidth * 2.1, districtHalfDepth * 2.05),
    new THREE.MeshStandardMaterial({
      color: night ? 0x35434a : 0xaab3af,
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
  const roadColor = night ? 0x202f38 : 0x46545a
  const plazaColor = night ? 0x56636a : 0xd0d5d2
  const markingColor = night ? 0xd7d2a0 : 0xf1ebd3
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
  const districtGlassFacades: PlaneInstance[] = []
  const rooftopGlass: PlaneInstance[] = []
  const treeInstances: BoxInstance[] = []
  const signatureTowerInstances: BoxInstance[] = []
  const signatureCrownInstances: BoxInstance[] = []
  const architecturalGlowInstances: BoxInstance[] = []
  const streetLightGlows: BoxInstance[] = []
  const streetLightPools: PlaneInstance[] = []

  const hq = addHqStackedOfficeFloors({
    structureInstances,
    propInstances,
    districtGlassFacades,
    facadeWindows,
    stackedFloors: stackedHqFloors,
    totalWidth,
    totalDepth,
    groundY,
    night,
    variant,
    random,
  })
  const {
    shaftWidth,
    shaftDepth,
    lobbyWidth,
    lobbyDepth,
    crownWidth,
    crownDepth,
    upperTop,
    landmarkTotalHeight,
  } = hq
  const lowerWidth = lobbyWidth
  const lowerDepth = lobbyDepth
  const upperDepth = crownDepth
  // Keep slender shaft metrics available for atrium fins / crown accents.
  const hqShaftAccent = Math.min(shaftWidth, shaftDepth)

  const secondaryCount = variant === "full" ? 72 : 28
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
    [-0.3, -1.03],
    [0.3, -1.03],
    [-1.02, 0.26],
    [1.02, 0.26],
    [-0.98, 0.7],
    [0.98, 0.7],
    [-0.78, -0.88],
    [-0.26, -0.9],
    [0.26, -0.9],
    [0.78, -0.88],
    [-1.04, -0.08],
    [1.04, -0.08],
    [-0.42, -1.12],
    [0.42, -1.12],
    [-1.12, -0.42],
    [1.12, -0.42],
    [-1.08, 0.48],
    [1.08, 0.48],
    [-0.18, -0.68],
    [0.18, -0.68],
    [-0.66, -0.78],
    [0.66, -0.78],
    [-1.16, -0.68],
    [1.16, -0.68],
    [-0.38, -0.44],
    [0.38, -0.44],
    [-0.92, -0.12],
    [0.92, -0.12],
    [-0.72, 0.56],
    [0.72, 0.56],
    [-0.12, -0.52],
    [0.12, -0.52],
    [-1.18, 0.36],
    [1.18, 0.36],
  ]
  // Fill remaining CBD lots on a ring/grid so full can reach 72 towers.
  if (normalizedLots.length < secondaryCount) {
    const cols = 8
    let cursor = 0
    while (normalizedLots.length < secondaryCount && cursor < 220) {
      const row = Math.floor(cursor / cols)
      const col = cursor % cols
      const nx = -1.2 + (col / Math.max(1, cols - 1)) * 2.4
      const nz = -1.22 + (row / 7) * 2.15
      cursor += 1
      if (Math.hypot(nx, nz) < 0.42) continue
      const jitterX = ((cursor * 37) % 11) * 0.008 - 0.04
      const jitterZ = ((cursor * 53) % 11) * 0.008 - 0.04
      normalizedLots.push([nx + jitterX, nz + jitterZ])
    }
  }

  // Deep blue steel + blue glass CBD (not teal/cyan pastel).
  const dayBuildingColors = [0x3a5568, 0x2a4558, 0x4a6578, 0x1e3a4c, 0x355568, 0x2e4a5c, 0x456070, 0x243e50, 0x3e5a6c]
  const nightBuildingColors = [0x182e3c, 0x1e3a4c, 0x283e4e, 0x152c3c, 0x304554, 0x1a3040, 0x1e3444, 0x16304a, 0x243848]
  const dayGlassColors = [0x4a82a8, 0x3a6e98, 0x5a92b8, 0x2e6288, 0x457aa0, 0x3e7898, 0x528ab0]
  const nightGlassColors = [0x163a58, 0x1a4568, 0x205078, 0x123048, 0x1e4868, 0x184060, 0x245878]
  const secondaryBuildings: Building[] = []
  let signatureTowerCount = 0
  let architecturalCrownCount = 0
  let tallestBuildingHeight = landmarkTotalHeight
  let terraceAmenityCount = 0
  const midTowerThreshold = landmarkTotalHeight * 0.22
  const tallTowerThreshold = landmarkTotalHeight * 0.28
  const signaturePadThreshold = landmarkTotalHeight * 0.35
  const crownScale = Math.max(1, landmarkTotalHeight / 48)

  for (let index = 0; index < secondaryCount; index += 1) {
    const [normalizedX, normalizedZ] = normalizedLots[index]
    const lotWidth = 5.8 + random() * 6.2
    const lotDepth = 5.5 + random() * 5.9
    const foregroundPenalty =
      normalizedZ > 0.42
        ? landmarkTotalHeight * (0.28 + random() * 0.12)
        : normalizedZ > 0.2
          ? landmarkTotalHeight * (0.08 + random() * 0.06)
          : 0
    const skylineBoost =
      normalizedZ < -0.58
        ? landmarkTotalHeight * (0.12 + random() * 0.1)
        : normalizedZ < -0.25
          ? landmarkTotalHeight * (0.06 + random() * 0.08)
          : normalizedZ < 0.2
            ? landmarkTotalHeight * (0.04 + random() * 0.06)
            : landmarkTotalHeight * (0.02 + random() * 0.03)
    const minHeight = landmarkTotalHeight * 0.16
    const maxHeight = landmarkTotalHeight * 0.94
    const height = Math.min(
      maxHeight,
      Math.max(minHeight, minHeight + random() * (maxHeight - minHeight) * 0.55 + skylineBoost - foregroundPenalty),
    )
    const slenderness =
      height > landmarkTotalHeight * 0.55 ? 0.72 : height > landmarkTotalHeight * 0.35 ? 0.82 : 0.92
    const width = lotWidth * slenderness
    const depth = lotDepth * (height > landmarkTotalHeight * 0.45 ? 0.78 : 0.9)
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
    tallestBuildingHeight = Math.max(tallestBuildingHeight, height)
    secondaryBuildings.push(building)
    structureInstances.push({
      position: [x, groundY + height / 2, z],
      scale: [width, height, depth],
      color: building.color,
      rotation: [0, (random() - 0.5) * 0.08, 0],
    })
    const towerProfile = index % 4
    if (index % 3 === 0) {
      const crownHeight = (0.58 + random() * 0.72) * Math.min(2.4, crownScale * 0.35)
      structureInstances.push({
        position: [x, groundY + height + crownHeight / 2, z],
        scale: [width * (towerProfile === 0 ? 0.54 : 0.68), crownHeight, depth * 0.64],
        color: night ? 0x3a5a70 : 0x5a7a90,
      })
      architecturalCrownCount += 1
    }
    if (height > midTowerThreshold) {
      const setbackHeight = Math.min(height * 0.12, height * (towerProfile === 2 ? 0.18 : 0.14))
      structureInstances.push({
        position: [x, groundY + height - setbackHeight / 2, z],
        scale: [width * (towerProfile === 2 ? 0.68 : 0.82), setbackHeight, depth * 0.8],
        color: night ? 0x2a4a60 : 0x4a6a80,
      })
      if (towerProfile === 2 && height > tallTowerThreshold) {
        const upperSetbackHeight = Math.min(height * 0.08, landmarkTotalHeight * 0.02)
        structureInstances.push({
          position: [x, groundY + height - upperSetbackHeight / 2, z],
          scale: [width * 0.5, upperSetbackHeight, depth * 0.58],
          color: night ? 0x355870 : 0x5a7a90,
        })
      }
    }
    const signatureTower = index % 5 === 1
    if (signatureTower) {
      signatureTowerCount += 1
      architecturalCrownCount += 1
      const crownHeight = (4.4 + random() * 3.2) * Math.min(1.8, crownScale * 0.28)
      const sigCrownWidth = width * (0.42 + random() * 0.08)
      const sigCrownDepth = depth * (0.42 + random() * 0.08)
      signatureTowerInstances.push({
        position: [x, groundY + height + crownHeight / 2 - 0.08, z],
        scale: [sigCrownWidth, crownHeight, sigCrownDepth],
        color: night ? 0x3a6080 : 0x4a7898,
        rotation: [0, Math.PI / 8, 0],
      })
      signatureCrownInstances.push({
        position: [x, groundY + height + crownHeight + 0.16, z],
        scale: [sigCrownWidth * 1.08, 0.24, sigCrownDepth * 1.08],
        color: night ? 0xffd98e : 0xf2fbff,
        rotation: [0, Math.PI / 8, 0],
      })
      propInstances.push({
        position: [x, groundY + height + crownHeight + 1.12, z],
        scale: [0.08, 2.08 * Math.min(1.6, crownScale * 0.25), 0.08],
        color: night ? 0xffc66f : 0x5c7480,
      })
      architecturalGlowInstances.push({
        position: [x, groundY + height + crownHeight + 1.12, z],
        scale: [0.13, 2.12 * Math.min(1.6, crownScale * 0.25), 0.13],
        color: fullNight ? 0xffcb77 : timePhase === "dusk" ? 0xffb87a : 0xb8eaf2,
      })
    } else if (towerProfile === 3 && height > tallTowerThreshold) {
      const finHeight = Math.min(height * 0.08, landmarkTotalHeight * 0.025)
      for (const side of [-1, 1]) {
        propInstances.push({
          position: [x + side * width * 0.24, groundY + height + finHeight / 2, z],
          scale: [0.12, finHeight, depth * 0.44],
          color: night ? 0x4a7898 : 0x6a9ab8,
        })
      }
      propInstances.push({
        position: [x, groundY + height + finHeight, z],
        scale: [width * 0.62, 0.14, depth * 0.5],
        color: night ? 0x5a88a8 : 0x7aa8c8,
      })
      architecturalGlowInstances.push({
        position: [x, groundY + height + finHeight + 0.035, z],
        scale: [width * 0.56, 0.08, depth * 0.44],
        color: fullNight ? 0x7de7f2 : timePhase === "dusk" ? 0xf2b786 : 0xc9edf2,
      })
      architecturalCrownCount += 1
    }
    const facadePalette = night ? nightGlassColors : dayGlassColors
    const facadeColor = facadePalette[(index + towerProfile) % facadePalette.length]
    const facadeHeight = height * 0.9
    districtGlassFacades.push(
      {
        position: [x, groundY + height * 0.52, z + depth / 2 + 0.025],
        scale: [width * 0.92, facadeHeight],
        color: facadeColor,
      },
      {
        position: [x, groundY + height * 0.52, z - depth / 2 - 0.025],
        scale: [width * 0.92, facadeHeight],
        color: facadeColor,
        rotation: [0, Math.PI, 0],
      },
      {
        position: [x - width / 2 - 0.025, groundY + height * 0.52, z],
        scale: [depth * 0.9, facadeHeight],
        color: facadeColor,
        rotation: [0, Math.PI / 2, 0],
      },
      {
        position: [x + width / 2 + 0.025, groundY + height * 0.52, z],
        scale: [depth * 0.9, facadeHeight],
        color: facadeColor,
        rotation: [0, -Math.PI / 2, 0],
      },
    )
    propInstances.push({
      position: [
        x + width * 0.31,
        groundY + height * 0.54,
        z + depth / 2 + 0.06,
      ],
      scale: [0.13, height * 0.74, 0.12],
      color: night ? 0x4a88a8 : 0x6aa0c0,
    })
    if (variant === "full" && height > tallTowerThreshold) {
      propInstances.push({
        position: [x - width * 0.28, groundY + height * 0.53, z + depth / 2 + 0.07],
        scale: [0.08, height * 0.72, 0.1],
        color: night ? 0x3a7088 : 0x5a90b0,
      })
    }
    addFacadeWindows(facadeWindows, building, groundY, variant, random, night)

    if (signatureTower && height > signaturePadThreshold) {
      const padY = groundY + height + 0.08
      propInstances.push(
        {
          position: [x, padY, z],
          scale: [width * 0.72, 0.12, depth * 0.72],
          color: night ? 0x2a3f4c : 0x8a9aa4,
        },
        {
          position: [x, padY + 0.1, z],
          scale: [width * 0.28, 0.05, depth * 0.05],
          color: night ? 0xffd98e : 0xf2fbff,
        },
        {
          position: [x, padY + 0.1, z],
          scale: [width * 0.05, 0.05, depth * 0.28],
          color: night ? 0xffd98e : 0xf2fbff,
        },
      )
      terraceAmenityCount += 3
      architecturalGlowInstances.push({
        position: [x, padY + 0.14, z],
        scale: [width * 0.55, 0.04, depth * 0.55],
        color: fullNight ? 0x7de7f2 : timePhase === "dusk" ? 0xf2b786 : 0xc9edf2,
      })
    }
  }

  // Sky bridges between nearby tall offices — modern CBD connectivity.
  if (variant === "full") {
    const bridgeMinDist = Math.max(12, districtHalfWidth * 0.08)
    const bridgeMaxDist = Math.max(48, districtHalfWidth * 0.32)
    const bridgeCandidates = secondaryBuildings
      .map((building, index) => ({ building, index }))
      .filter(({ building }) => building.height > midTowerThreshold)
      .sort((a, b) => b.building.height - a.building.height)
    let bridgesBuilt = 0
    for (let i = 0; i < bridgeCandidates.length && bridgesBuilt < 5; i += 1) {
      for (let j = i + 1; j < bridgeCandidates.length && bridgesBuilt < 5; j += 1) {
        const a = bridgeCandidates[i].building
        const b = bridgeCandidates[j].building
        const dx = b.x - a.x
        const dz = b.z - a.z
        const dist = Math.hypot(dx, dz)
        if (dist < bridgeMinDist || dist > bridgeMaxDist) continue
        const midX = (a.x + b.x) / 2
        const midZ = (a.z + b.z) / 2
        const bridgeY =
          groundY + Math.min(a.height, b.height) * (0.62 + random() * 0.12)
        const yaw = Math.atan2(dz, dx)
        structureInstances.push({
          position: [midX, bridgeY, midZ],
          scale: [dist * 0.92, Math.max(0.55, landmarkTotalHeight * 0.0012), 1.15],
          color: night ? 0x2a4554 : 0x4a6578,
          rotation: [0, yaw, 0],
        })
        districtGlassFacades.push({
          position: [midX, bridgeY + 0.05, midZ],
          scale: [dist * 0.88, 0.42],
          color: night ? 0x1a4568 : 0x4a82a8,
          rotation: [0, yaw, 0],
        })
        architecturalGlowInstances.push({
          position: [midX, bridgeY - 0.28, midZ],
          scale: [dist * 0.86, 0.06, 0.9],
          color: fullNight ? 0x66e6f2 : timePhase === "dusk" ? 0xf2bc8f : 0x8bcbd5,
          rotation: [0, yaw, 0],
        })
        architecturalCrownCount += 1
        terraceAmenityCount += 1
        bridgesBuilt += 1
        break
      }
    }
  }

  architecturalGlowInstances.push(
    {
      position: [0, upperTop - 0.015, lowerDepth / 2 + 0.15],
      scale: [lowerWidth * 0.88, 0.07, 0.08],
      color: fullNight ? 0x72e5f0 : timePhase === "dusk" ? 0xf0b385 : 0xb9e6eb,
    },
    {
      position: [-lowerWidth / 2 - 0.15, upperTop - 0.015, 0],
      scale: [0.08, 0.07, lowerDepth * 0.82],
      color: fullNight ? 0x72e5f0 : timePhase === "dusk" ? 0xf0b385 : 0xb9e6eb,
    },
  )
  architecturalCrownCount += 1

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

  if (signatureTowerInstances.length > 0) {
    const signatureTowers = createCylinderInstances(
      signatureTowerInstances,
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: night ? 0.18 : 0.24,
        metalness: 0.58,
      }),
    )
    signatureTowers.userData.agentOfficeEnvironment = "edge-district"
    scene.add(signatureTowers)

    const signatureCrowns = createCylinderInstances(
      signatureCrownInstances,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: night ? 0.92 : 0.58,
        toneMapped: false,
      }),
    )
    signatureCrowns.renderOrder = 4
    signatureCrowns.userData.agentOfficeEnvironment = "edge-district"
    scene.add(signatureCrowns)
  }

  const districtGlassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    emissive: fullNight ? 0x092b3d : timePhase === "dusk" ? 0x251c24 : 0x092733,
    emissiveIntensity: fullNight ? 0.62 : timePhase === "dusk" ? 0.32 : 0.08,
    roughness: 0.045,
    metalness: 0.58,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    transparent: true,
    opacity: fullNight ? 0.6 : timePhase === "dusk" ? 0.48 : 0.42,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  districtGlassMaterial.forceSinglePass = true
  const districtGlassMesh = createPlaneInstances(districtGlassFacades, districtGlassMaterial)
  districtGlassMesh.renderOrder = 1
  districtGlassMesh.userData.agentOfficeEnvironment = "edge-district"
  scene.add(districtGlassMesh)

  const facadeMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: night ? 0.94 : 0.7,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  facadeMaterial.forceSinglePass = true
  const facadeMesh = createPlaneInstances(facadeWindows, facadeMaterial)
  facadeMesh.renderOrder = 3
  facadeMesh.userData.agentOfficeEnvironment = "edge-district"
  scene.add(facadeMesh)

  const atriumHeight = upperTop - groundY - 1.2
  const atriumWidth = Math.max(3.2, Math.min(hqShaftAccent * 0.42, shaftWidth * 0.22))
  const atrium = new THREE.Mesh(
    new THREE.BoxGeometry(atriumWidth, atriumHeight, 0.38),
    new THREE.MeshPhysicalMaterial({
      color: night ? 0x2a6a90 : 0x4a8eb8,
      emissive: night ? 0x0e3a58 : 0x1a5070,
      emissiveIntensity: night ? 1.12 : 0.22,
      roughness: 0.06,
      metalness: 0.28,
      clearcoat: 0.82,
      clearcoatRoughness: 0.1,
      transparent: true,
      opacity: night ? 0.76 : 0.56,
      depthWrite: false,
    }),
  )
  atrium.position.set(0, groundY + 0.6 + atriumHeight / 2, lowerDepth / 2 + 0.13)
  atrium.renderOrder = 4
  atrium.userData.agentOfficeEnvironment = "edge-district"
  scene.add(atrium)

  const deckWidth = totalWidth + 14
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

  const terraceAccent = night ? 0x6ad9ea : 0x1687a0
  propInstances.push(
    {
      position: [0, 0.035, deckOuterZ + 2.28],
      scale: [deckWidth * 0.84, 0.055, 0.08],
      color: terraceAccent,
    },
    {
      position: [-deckWidth / 2 + 0.42, 0.035, (deckInnerZ + deckOuterZ) / 2],
      scale: [0.08, 0.055, deckOuterZ - deckInnerZ + 0.8],
      color: terraceAccent,
    },
    {
      position: [deckWidth / 2 - 0.42, 0.035, (deckInnerZ + deckOuterZ) / 2],
      scale: [0.08, 0.055, deckOuterZ - deckInnerZ + 0.8],
      color: terraceAccent,
    },
  )
  architecturalGlowInstances.push(
    {
      position: [0, 0.052, deckOuterZ + 2.29],
      scale: [deckWidth * 0.84, 0.045, 0.11],
      color: fullNight ? 0x66e6f2 : timePhase === "dusk" ? 0xf2bc8f : 0x8bcbd5,
    },
    {
      position: [-deckWidth / 2 + 0.42, 0.052, (deckInnerZ + deckOuterZ) / 2],
      scale: [0.11, 0.045, deckOuterZ - deckInnerZ + 0.8],
      color: fullNight ? 0x66e6f2 : timePhase === "dusk" ? 0xf2bc8f : 0x8bcbd5,
    },
    {
      position: [deckWidth / 2 - 0.42, 0.052, (deckInnerZ + deckOuterZ) / 2],
      scale: [0.11, 0.045, deckOuterZ - deckInnerZ + 0.8],
      color: fullNight ? 0x66e6f2 : timePhase === "dusk" ? 0xf2bc8f : 0x8bcbd5,
    },
  )

  const receptionZ = deckOuterZ + 0.58
  propInstances.push(
    {
      position: [0, 0.48, receptionZ],
      scale: [4.25, 0.86, 0.72],
      color: night ? 0x1b3340 : 0x355d6a,
    },
    {
      position: [0, 0.96, receptionZ - 0.04],
      scale: [4.55, 0.12, 0.92],
      color: night ? 0x87979d : 0xe9eeeb,
    },
  )
  terraceAmenityCount += 2
  architecturalGlowInstances.push({
    position: [0, 0.58, receptionZ + 0.37],
    scale: [3.45, 0.08, 0.045],
    color: fullNight ? 0x72e7f1 : timePhase === "dusk" ? 0xffc18b : 0xb7dfe4,
  })
  for (const side of [-1, 1]) {
    const stoolX = side * 1.15
    propInstances.push(
      {
        position: [stoolX, 0.28, receptionZ - 1.05],
        scale: [0.12, 0.52, 0.12],
        color: night ? 0x6f8188 : 0x87999f,
      },
      {
        position: [stoolX, 0.56, receptionZ - 1.05],
        scale: [0.64, 0.12, 0.64],
        color: night ? 0xbfc9cc : 0xf5f6f3,
      },
    )
    terraceAmenityCount += 2

    const planterX = side * Math.min(4.1, deckWidth * 0.13)
    propInstances.push({
      position: [planterX, 0.22, receptionZ + 0.12],
      scale: [0.72, 0.44, 0.72],
      color: night ? 0x51656f : 0xdde5e2,
    })
    treeInstances.push({
      position: [planterX, 0.98, receptionZ + 0.12],
      scale: [0.42, 0.58, 0.42],
      color: night ? 0x2b6b53 : 0x32855e,
    })
    terraceAmenityCount += 1
  }

  const collaborationZ = totalDepth / 2 + 4.65
  const premiumDeckWidth = Math.min(13.2, totalWidth * 0.48)
  propInstances.push({
    position: [0, -0.015, collaborationZ],
    scale: [premiumDeckWidth, 0.1, 4.75],
    color: night ? 0x253c49 : 0x9db0b5,
  })
  terraceAmenityCount += 1
  propInstances.push(
    {
      position: [0, 0.82, collaborationZ],
      scale: [3.8, 0.16, 1.16],
      color: night ? 0x213746 : 0x365b6c,
    },
    {
      position: [0, 0.43, collaborationZ],
      scale: [0.18, 0.72, 0.68],
      color: night ? 0x62747e : 0x8b9ca3,
    },
  )
  terraceAmenityCount += 2
  for (const side of [-1, 1]) {
    for (const offset of [-1.18, 0, 1.18]) {
      propInstances.push({
        position: [offset, 0.46, collaborationZ + side * 1.05],
        scale: [0.72, 0.46, 0.68],
        color: night ? 0xd3d9dc : 0xf5f6f4,
      })
      terraceAmenityCount += 1
    }
  }

  const amenityOffset = Math.min(deckWidth * 0.31, 12.6)
  const reflectionPoolX = -amenityOffset
  propInstances.push(
    {
      position: [reflectionPoolX, 0.005, collaborationZ],
      scale: [5.15, 0.12, 2.72],
      color: night ? 0x718087 : 0xe6ece9,
    },
    {
      position: [reflectionPoolX, 0.075, collaborationZ],
      scale: [4.72, 0.04, 2.3],
      color: fullNight ? 0x1f87a3 : timePhase === "dusk" ? 0x6f7785 : 0x58b7c8,
    },
  )
  architecturalGlowInstances.push(
    {
      position: [reflectionPoolX, 0.105, collaborationZ - 1.16],
      scale: [4.72, 0.035, 0.055],
      color: fullNight ? 0x78e3f0 : 0xb4e5ea,
    },
    {
      position: [reflectionPoolX, 0.105, collaborationZ + 1.16],
      scale: [4.72, 0.035, 0.055],
      color: fullNight ? 0x78e3f0 : 0xb4e5ea,
    },
  )
  terraceAmenityCount += 2

  const loungeX = amenityOffset
  const loungeUpholstery = night ? 0xbfcbd0 : 0xf5f7f5
  for (const side of [-1, 1]) {
    propInstances.push(
      {
        position: [loungeX, 0.3, collaborationZ + side * 0.82],
        scale: [3.45, 0.44, 0.72],
        color: loungeUpholstery,
      },
      {
        position: [loungeX, 0.68, collaborationZ + side * 1.08],
        scale: [3.45, 0.64, 0.18],
        color: night ? 0x91a3ab : 0xd8e0de,
        rotation: [side * 0.08, 0, 0],
      },
    )
    terraceAmenityCount += 2
  }
  propInstances.push(
    {
      position: [loungeX, 0.38, collaborationZ],
      scale: [1.9, 0.12, 1.18],
      color: night ? 0x1c303b : 0x335867,
    },
    {
      position: [loungeX, 0.19, collaborationZ],
      scale: [0.16, 0.38, 0.62],
      color: night ? 0x61747d : 0x80959d,
    },
  )
  terraceAmenityCount += 2

  const pergolaWidth = Math.min(11, totalWidth * 0.42)
  for (const x of [-pergolaWidth / 2, pergolaWidth / 2]) {
    propInstances.push({
      position: [x, 1.62, collaborationZ],
      scale: [0.12, 3.18, 0.12],
      color: night ? 0x263f4e : 0x718690,
    })
  }
  propInstances.push({
    position: [0, 3.18, collaborationZ],
    scale: [pergolaWidth + 0.2, 0.14, 0.18],
    color: night ? 0x263f4e : 0x718690,
  })
  const pergolaSlats = variant === "full" ? 7 : 4
  for (let index = 0; index < pergolaSlats; index += 1) {
    const x = -pergolaWidth / 2 + (index / Math.max(1, pergolaSlats - 1)) * pergolaWidth
    propInstances.push({
      position: [x, 3.22, collaborationZ],
      scale: [0.1, 0.1, 3.15],
      color: night ? 0x304d5d : 0x8297a0,
    })
  }
  architecturalGlowInstances.push({
    position: [0, 3.135, collaborationZ],
    scale: [pergolaWidth * 0.82, 0.055, 0.1],
    color: fullNight ? 0xffdda0 : timePhase === "dusk" ? 0xffc38f : 0xcde9e8,
  })

  const brandSign = createBrandSign()
  if (brandSign) {
    brandSign.position.set(0, 1.15, deckOuterZ + 2.38)
    scene.add(brandSign)
  }

  const addStreetLight = (x: number, z: number, armZ: number) => {
    const lampY = groundY + 3.45
    propInstances.push(
      {
        position: [x, groundY + 1.7, z],
        scale: [0.09, 3.4, 0.09],
        color: night ? 0x4d5961 : 0x62717a,
      },
      {
        position: [x, lampY, z + armZ * 0.34],
        scale: [0.08, 0.08, 0.72],
        color: night ? 0x4d5961 : 0x62717a,
      },
      {
        position: [x, lampY - 0.05, z + armZ * 0.7],
        scale: [0.38, 0.11, 0.2],
        color: night ? 0xffe4ad : 0xd9e6e8,
      },
    )
    streetLightGlows.push({
      position: [x, lampY - 0.12, z + armZ * 0.72],
      scale: [1, 1, 1],
      color: night ? 0xffd89a : 0xdceff2,
    })
    streetLightPools.push({
      position: [x, groundY + 0.045, z + armZ * 0.72],
      scale: [3.4, 3.4],
      color: night ? 0xffd38b : 0xd8edf0,
      rotation: [-Math.PI / 2, 0, 0],
    })
  }

  const boulevardLampPairs = variant === "full" ? 7 : 4
  for (let index = 0; index < boulevardLampPairs; index += 1) {
    const progress = (index + 0.5) / boulevardLampPairs
    const x = -districtHalfWidth * 0.86 + progress * districtHalfWidth * 1.72
    addStreetLight(x, frontBoulevardZ - 3.25, 1)
    addStreetLight(x, backBoulevardZ + 2.8, -1)
  }

  const streetGlowMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.22, 12, 8),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: night ? 0.92 : 0.24,
      depthWrite: false,
      toneMapped: false,
    }),
    streetLightGlows.length,
  )
  streetLightGlows.forEach((instance, index) => {
    setInstanceTransform(streetGlowMesh, index, instance.position, instance.scale)
    streetGlowMesh.setColorAt(index, new THREE.Color(instance.color))
  })
  streetGlowMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  if (streetGlowMesh.instanceColor) streetGlowMesh.instanceColor.needsUpdate = true
  streetGlowMesh.frustumCulled = false
  streetGlowMesh.renderOrder = 6
  streetGlowMesh.userData.agentOfficeEnvironment = "edge-district"
  scene.add(streetGlowMesh)

  const streetPools = createPlaneInstances(
    streetLightPools,
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: night ? 0.14 : 0.035,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    }),
  )
  streetPools.renderOrder = 2
  streetPools.userData.agentOfficeEnvironment = "edge-district"
  scene.add(streetPools)

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

  const architecturalGlowMesh = createBoxInstances(
    architecturalGlowInstances,
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: fullNight ? 0.94 : timePhase === "dusk" ? 0.76 : 0.42,
      depthWrite: false,
      toneMapped: false,
    }),
  )
  architecturalGlowMesh.renderOrder = 6
  architecturalGlowMesh.userData.agentOfficeEnvironment = "edge-district"
  scene.add(architecturalGlowMesh)

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

  const vehicleCount = variant === "full" ? 16 : 6
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
        scale: [1.5, 0.38, 0.72],
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
        scale: [1.5, 0.38, 0.72],
      })
    }
  }

  const vehicleMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.32,
    metalness: 0.58,
  })
  const vehicleMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    vehicleMaterial,
    vehicleRoutes.length,
  )
  const vehicleColors = night
    ? [0xffcf67, 0xc5d9e8, 0x55b7d4, 0xe3695d, 0x8bd4a0, 0xb9a0e8, 0xe8a0c8]
    : [0xf3f4f4, 0x254f68, 0xd8564b, 0xe0a63b, 0x2a9d4a, 0x4a6a8a, 0x8a4a8a]
  vehicleRoutes.forEach((_, index) => {
    vehicleMesh.setColorAt(index, new THREE.Color(vehicleColors[index % vehicleColors.length]))
  })
  if (vehicleMesh.instanceColor) vehicleMesh.instanceColor.needsUpdate = true
  vehicleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  vehicleMesh.frustumCulled = false
  vehicleMesh.castShadow = false
  vehicleMesh.userData.agentOfficeEnvironment = "edge-district"
  scene.add(vehicleMesh)

  const vehicleLightMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.2, 0.12, 0.12),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: night ? 0.96 : 0.32,
      toneMapped: false,
    }),
    vehicleRoutes.length * 4,
  )
  vehicleRoutes.forEach((_, routeIndex) => {
    for (let lampIndex = 0; lampIndex < 4; lampIndex += 1) {
      vehicleLightMesh.setColorAt(
        routeIndex * 4 + lampIndex,
        new THREE.Color(lampIndex < 2 ? 0xffefc4 : 0xff4f3d),
      )
    }
  })
  if (vehicleLightMesh.instanceColor) vehicleLightMesh.instanceColor.needsUpdate = true
  vehicleLightMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  vehicleLightMesh.frustumCulled = false
  vehicleLightMesh.renderOrder = 5
  vehicleLightMesh.userData.agentOfficeEnvironment = "edge-district"
  scene.add(vehicleLightMesh)

  const vehicleDummy = new THREE.Object3D()
  const vehicleLightDummy = new THREE.Object3D()
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

      const forwardX = route.axis === "x" ? route.direction : 0
      const forwardZ = route.axis === "z" ? route.direction : 0
      const sideX = -forwardZ
      const sideZ = forwardX
      const centerX = route.axis === "x" ? position : route.lane
      const centerZ = route.axis === "z" ? position : route.lane
      for (let lampIndex = 0; lampIndex < 4; lampIndex += 1) {
        const front = lampIndex < 2 ? 1 : -1
        const side = lampIndex % 2 === 0 ? -1 : 1
        vehicleLightDummy.position.set(
          centerX + forwardX * 0.7 * front + sideX * 0.21 * side,
          groundY + 0.32,
          centerZ + forwardZ * 0.7 * front + sideZ * 0.21 * side,
        )
        vehicleLightDummy.rotation.set(0, route.axis === "z" ? Math.PI / 2 : 0, 0)
        vehicleLightDummy.scale.set(1, 1, 1)
        vehicleLightDummy.updateMatrix()
        vehicleLightMesh.setMatrixAt(index * 4 + lampIndex, vehicleLightDummy.matrix)
      }
    })
    vehicleMesh.instanceMatrix.needsUpdate = true
    vehicleLightMesh.instanceMatrix.needsUpdate = true
  }
  animateVehicles(0)

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(night ? 1.1 : 1.55, 24, 16),
    new THREE.MeshBasicMaterial({
      color: night ? 0xe8f1ff : 0xffefb1,
      fog: false,
    }),
  )
  const beaconY = Math.max(night ? 20 : 25, -groundY * 0.08)
  beacon.position.set(night ? 25 : -29, beaconY, -districtHalfDepth - 72)
  beacon.userData.agentOfficeEnvironment = "edge-district"
  scene.add(beacon)

  if (fullNight) {
    const starCount = variant === "full" ? 150 : 55
    const starPositions = new Float32Array(starCount * 3)
    const starBase = Math.max(7, -groundY * 0.05)
    const starSpan = Math.max(39, -groundY * 0.35)
    for (let index = 0; index < starCount; index += 1) {
      starPositions[index * 3] = (random() - 0.5) * districtHalfWidth * 3
      starPositions[index * 3 + 1] = starBase + random() * starSpan
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
      ? Math.max(52, totalWidth * 1.38, totalDepth * 1.5)
      : Math.max(60, totalWidth * 1.44, totalDepth * 1.56)
  const landscapeDistance = variant === "thumbnail" ? baseDistance * 0.94 : baseDistance
  const portraitDistance = landscapeDistance * (variant === "thumbnail" ? 1.2 : 1.42)

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
      signatureTowers: signatureTowerCount,
      architecturalCrowns: architecturalCrownCount,
      glassFacades: districtGlassFacades.length,
      terraceAmenities: terraceAmenityCount,
      tallestBuildingHeight,
      windows: facadeWindows.length,
      trees: treeInstances.length,
      vehicles: vehicleRoutes.length,
      lightFixtures: streetLightGlows.length,
      // Curtain walls removed (per-floor glass is instanced); keep ≤28 budget.
      expectedDrawCalls: night ? 25 : 24,
      hqStackedFloors: stackedHqFloors,
      hqFloorHeight: HQ_FLOOR_TO_FLOOR,
    },
    framing: {
      target: new THREE.Vector3(
        0,
        variant === "thumbnail" ? 1.0 : 1.1,
        variant === "thumbnail" ? -totalDepth * 0.08 : 0,
      ),
      yaw: variant === "thumbnail" ? -0.64 : -0.62,
      pitch: variant === "thumbnail" ? 0.48 : 0.66,
      portraitPitch: variant === "thumbnail" ? 0.48 : 0.84,
      portraitTargetLift: variant === "thumbnail" ? 2.8 : 0.45,
      distance: landscapeDistance,
      landscapeDistance,
      portraitDistance,
      minDistance: 18,
      maxDistance: Math.max(420, -groundY * 1.35),
      groundY,
      officeY,
      districtWidth: districtHalfWidth * 2,
      districtDepth: districtHalfDepth * 2,
    },
  }
}
