"use client"

import * as React from "react"
import * as THREE from "three"

import {
  officeWorkerStance,
  type AgentOfficeActivity,
  type AgentOfficeDepartment,
  type AgentOfficeModel,
  type AgentOfficeStance,
  type AgentOfficeWorker,
} from "@/lib/agent-office-model"
import {
  officeTimeOfDay,
  officeTimePhase,
  type OfficeTimeOfDay,
  type OfficeTimePhase,
} from "@/lib/agent-office-environment"
import { cn } from "@/lib/utils"

import { addEdgeDistrict } from "./agent-office-city"
import {
  agentOfficeWorkerStationVisualState,
  applyAgentOfficeWorkerStationVisualState,
} from "./agent-office-visual-state"
import {
  allocateAgentOfficeStandbyMarkers,
  buildAgentOfficeDeskGrid,
  buildAgentOfficeLayout,
  selectAgentOfficeDepartments,
} from "./agent-office-layout"

export type AgentOfficeCameraCommand = {
  type: "reset" | "zoom-in" | "zoom-out"
  nonce: number
}

type AgentOfficeSceneProps = {
  model: AgentOfficeModel
  variant?: "full" | "thumbnail"
  paused?: boolean
  timeOfDay?: OfficeTimeOfDay
  timePhase?: OfficeTimePhase
  selectedWorkerId?: string | null
  cameraCommand?: AgentOfficeCameraCommand | null
  className?: string
  onSelectWorker?: (workerId: string) => void
  onSelectDepartment?: (departmentId: string) => void
  onReady?: () => void
}

type WorkerAnimation = {
  worker: AgentOfficeWorker
  stance: AgentOfficeStance
  group: THREE.Group
  head: THREE.Mesh
  leftArm: THREE.Group
  rightArm: THREE.Group
  leftLeg: THREE.Group
  rightLeg: THREE.Group
  screen: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  secondaryScreen: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  edgeGlowMaterial: THREE.MeshBasicMaterial
  lampGlowMaterial: THREE.MeshBasicMaterial
  activeBeacon: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>
  interactionTarget: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshBasicMaterial>
  badgeMaterial: THREE.MeshBasicMaterial
  statusHaloMaterial: THREE.MeshBasicMaterial
  label: THREE.Sprite | null
  labelSignature: string | null
  selectionRing: THREE.Mesh
  walkPath: THREE.CatmullRomCurve3
  walkSpeed: number
  locomotion: boolean
  phase: number
  baseY: number
  /** Where the agent stands when it has nothing running. */
  standPosition: THREE.Vector3
  /** The chair in front of its own desk — where a running agent types. */
  seatPosition: THREE.Vector3
}

type DepartmentAnimation = {
  departmentId: string
  group: THREE.Group
  working: boolean
  activeColor: number
  boardMaterial: THREE.MeshStandardMaterial
  boardStatusMaterial: THREE.MeshBasicMaterial
  workLight: THREE.PointLight | null
  workLightIntensity: number
  pulse: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  label: THREE.Sprite | null
  labelSignature: string | null
  logicalAgentCount: number
  labelPosition: THREE.Vector3
  phase: number
}

type AgentOfficeCameraControls = {
  reset: () => void
  zoomIn: () => void
  zoomOut: () => void
}

type StandbyCapacityMarker = {
  position: [number, number, number]
  rotationY: number
  color: number
}

type CompactWorkerMarker = {
  worker: AgentOfficeWorker
  position: [number, number, number]
  rotationY: number
}

type CompactWorkerMesh = {
  mesh: THREE.InstancedMesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>
  workers: AgentOfficeWorker[]
  indexByWorkerId: Map<string, number>
}

/**
 * Seated pose. The rig's forward axis is local +z (walking sets
 * rotation.y = atan2(tangent.x, tangent.z)), and rotating a limb group by a
 * NEGATIVE angle about local x swings it toward +z — i.e. forward, onto the
 * keyboard. Sitting therefore drops the hips onto the chair and swings both
 * thighs and both arms forward.
 */
const SEAT_HIP_DROP = -0.3
const SEAT_LEG_PITCH = -0.75
const SEAT_ARM_PITCH = -1.02
const FULL_DETAILED_WORKER_BUDGET = 36
const THUMBNAIL_DETAILED_WORKER_BUDGET = 10
/**
 * How far in front of the desk centre the seated body sits. Derived, not
 * eyeballed: with SEAT_ARM_PITCH the hands land 0.45 behind the body, so 0.7
 * puts them at deskZ + 0.25 — on the desktop (which spans ±0.39) where a
 * keyboard would be — while the hips stay inside the chair cushion at
 * deskZ + 0.88 (radius 0.32).
 */
const SEAT_FORWARD_OFFSET = 0.7

type PhaseLighting = {
  sunColor: number
  sunIntensity: number
  sunPosition: [number, number, number]
  hemisphereSky: number
  hemisphereGround: number
  hemisphereIntensity: number
  fillColor: number
  fillIntensity: number
  exposure: number
  background: number
  fog: number
  horizon: number
  floor: number
}

/**
 * Lighting per resolved phase. "dawn" and "dusk" only ever occur inside the
 * daylight window (see officeTimePhase), so they warm the same day structure
 * instead of fighting the night sky.
 */
const PHASE_LIGHTING: Record<OfficeTimePhase, PhaseLighting> = {
  dawn: {
    sunColor: 0xffd7a8,
    sunIntensity: 2.08,
    sunPosition: [22, 13, 10],
    hemisphereSky: 0xffe6cd,
    hemisphereGround: 0x5b5a63,
    hemisphereIntensity: 1.55,
    fillColor: 0xc9bcff,
    fillIntensity: 1.12,
    exposure: 1.1,
    background: 0xb7ccd9,
    fog: 0xc7cfd3,
    horizon: 0xf0cfaf,
    floor: 0xd0d1cb,
  },
  day: {
    sunColor: 0xfff4dd,
    sunIntensity: 2.55,
    sunPosition: [-18, 28, 14],
    hemisphereSky: 0xffffff,
    hemisphereGround: 0x53606a,
    hemisphereIntensity: 1.78,
    fillColor: 0xc9e7ff,
    fillIntensity: 1.28,
    exposure: 1.08,
    background: 0xadd3e2,
    fog: 0xb9d8e2,
    horizon: 0xd1e6eb,
    floor: 0xd7d8d3,
  },
  dusk: {
    sunColor: 0xffbd8b,
    sunIntensity: 1.92,
    sunPosition: [-24, 13, 8],
    hemisphereSky: 0xcda994,
    hemisphereGround: 0x3f4852,
    hemisphereIntensity: 1.52,
    fillColor: 0x9bc8ef,
    fillIntensity: 1.16,
    exposure: 1.12,
    background: 0x7c8492,
    fog: 0x75808d,
    horizon: 0xd8a17b,
    floor: 0xb8b9b3,
  },
  night: {
    sunColor: 0xa9c9ff,
    sunIntensity: 1.08,
    sunPosition: [-18, 28, 14],
    hemisphereSky: 0x789bb8,
    hemisphereGround: 0x12181d,
    hemisphereIntensity: 1.34,
    fillColor: 0x87b4df,
    fillIntensity: 0.94,
    exposure: 1.16,
    background: 0x0b1d2c,
    fog: 0x11283a,
    horizon: 0x31485b,
    floor: 0x697277,
  },
}

const ACTIVITY_COLORS: Record<AgentOfficeActivity, number> = {
  coordination: 0x18181b,
  software: 0x2563eb,
  publishing: 0xe85d4a,
  research: 0x0f8a7a,
  operations: 0xd29a24,
  localization: 0x7c5ce7,
  security: 0x278e62,
}

const STATUS_COLORS = {
  idle: 0x94a3b8,
  active: 0x38bdf8,
  ready: 0x34d399,
  attention: 0xf59e0b,
} as const

function compactWorkerColor(worker: AgentOfficeWorker): number {
  return STATUS_COLORS[worker.statusTone]
}

function detailedWorkerIds(
  departments: readonly AgentOfficeDepartment[],
  variant: "full" | "thumbnail",
): Set<string> {
  const budget = variant === "full"
    ? FULL_DETAILED_WORKER_BUDGET
    : THUMBNAIL_DETAILED_WORKER_BUDGET
  const selected = new Set<string>()
  const add = (worker: AgentOfficeWorker | undefined) => {
    if (worker && selected.size < budget) selected.add(worker.id)
  }

  // First keep every populated department visually represented. Remaining
  // detailed slots favour live/attention work; overflow is still rendered and
  // clickable through the compact instanced layer below.
  departments.forEach((department) => add(department.workers[0]))
  departments
    .flatMap((department) => department.workers)
    .sort((left, right) => (
      Number(right.active) - Number(left.active)
      || Number(right.statusTone === "attention") - Number(left.statusTone === "attention")
      || right.updatedAt - left.updatedAt
      || left.id.localeCompare(right.id)
    ))
    .forEach(add)

  return selected
}

function material(color: number, roughness = 0.72, metalness = 0.03) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness })
}

function tagObject(object: THREE.Object3D, data: Record<string, string>) {
  object.traverse((child) => Object.assign(child.userData, data))
}

function addDesk(sceneGroup: THREE.Group, x: number, z: number, active: boolean) {
  const desk = new THREE.Group()
  desk.position.set(x, 0, z)
  const visual = agentOfficeWorkerStationVisualState(active)

  // Modern sit-stand desk: slim top + brushed metal legs + dual ultrawide monitors.
  const desktop = new THREE.Mesh(
    new THREE.BoxGeometry(1.95, 0.09, 0.9),
    material(0x2a3a44, 0.38, 0.22),
  )
  desktop.position.y = 0.84
  desk.add(desktop)

  const edgeGlowMaterial = new THREE.MeshBasicMaterial({
    color: visual.edgeColor,
    transparent: true,
    opacity: visual.edgeOpacity,
  })
  const edgeGlow = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 0.02, 0.03),
    edgeGlowMaterial,
  )
  edgeGlow.position.set(0, 0.89, 0.44)
  desk.add(edgeGlow)

  const legMaterial = material(0x1c252d, 0.42, 0.55)
  for (const legX of [-0.78, 0.78]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.78, 0.55), legMaterial)
    leg.position.set(legX, 0.4, 0)
    desk.add(leg)
  }

  const dualOffsets = [-0.38, 0.38]
  const screens: Array<THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>> = []
  for (const offsetX of dualOffsets) {
    const monitorBack = new THREE.Mesh(
      new THREE.BoxGeometry(0.78, 0.5, 0.06),
      material(0x0f1724, 0.4, 0.22),
    )
    monitorBack.position.set(offsetX, 1.32, -0.24)
    monitorBack.rotation.x = -0.05
    desk.add(monitorBack)

    const screenMaterial = new THREE.MeshStandardMaterial({
      color: visual.screenColor,
      emissive: visual.screenEmissive,
      emissiveIntensity: visual.screenIntensity,
      roughness: 0.32,
    })
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.4), screenMaterial)
    screen.position.set(offsetX, 1.32, -0.2)
    desk.add(screen)
    screens.push(screen)

    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, 0.06), legMaterial)
    stand.position.set(offsetX, 1.05, -0.2)
    desk.add(stand)
  }

  const monitorBase = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.04, 0.28),
    legMaterial,
  )
  monitorBase.position.set(0, 0.91, -0.2)
  desk.add(monitorBase)

  const deskPad = new THREE.Mesh(
    new THREE.BoxGeometry(1.15, 0.016, 0.38),
    material(0x121c24, 0.9),
  )
  deskPad.position.set(0, 0.9, 0.18)
  desk.add(deskPad)

  const keyboard = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.022, 0.18),
    material(0xe6eef1, 0.68, 0.1),
  )
  keyboard.position.set(0, 0.925, 0.14)
  desk.add(keyboard)

  const trackpad = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.016, 0.16),
    material(0xcbd5db, 0.55, 0.12),
  )
  trackpad.position.set(0.42, 0.92, 0.2)
  desk.add(trackpad)

  const taskLight = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.05, 0.34, 10),
    material(0x8ea0aa, 0.48, 0.4),
  )
  taskLight.position.set(0.78, 1.08, -0.06)
  taskLight.rotation.z = -0.28
  desk.add(taskLight)

  const lampGlowMaterial = new THREE.MeshBasicMaterial({
    color: visual.lampColor,
    transparent: true,
    opacity: visual.lampOpacity,
  })
  const lampGlow = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 10, 8),
    lampGlowMaterial,
  )
  lampGlow.position.set(0.84, 1.24, -0.06)
  desk.add(lampGlow)

  // Keep the beacon in the topology so live status changes only toggle it;
  // rebuilding the whole WebGL city for a run transition is unnecessary.
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0x38bdf8 }),
  )
  beacon.name = "agent-office-active-beacon"
  beacon.position.set(0, 1.72, -0.22)
  beacon.visible = active
  desk.add(beacon)

  sceneGroup.add(desk)
  return {
    primaryScreen: screens[0],
    secondaryScreen: screens[1],
    edgeGlowMaterial,
    lampGlowMaterial,
    activeBeacon: beacon,
  }
}

function addChair(sceneGroup: THREE.Group, x: number, z: number) {
  const chair = new THREE.Group()
  chair.position.set(x, 0, z)
  const frame = material(0x222831, 0.82)
  const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.12, 12), frame)
  seat.position.y = 0.52
  chair.add(seat)
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.62, 0.12), frame)
  back.position.set(0, 0.85, 0.25)
  back.rotation.x = -0.1
  chair.add(back)
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.45, 10), frame)
  post.position.y = 0.27
  chair.add(post)
  sceneGroup.add(chair)
}

function createWorkerLabel(worker: AgentOfficeWorker) {
  const canvas = document.createElement("canvas")
  canvas.width = 640
  canvas.height = 132
  const context = canvas.getContext("2d")
  if (!context) return null

  context.fillStyle = "rgba(10, 19, 30, 0.9)"
  context.beginPath()
  context.roundRect(10, 10, 620, 112, 20)
  context.fill()
  context.strokeStyle = "rgba(180, 221, 232, 0.46)"
  context.lineWidth = 2
  context.stroke()

  context.fillStyle =
    worker.statusTone === "attention"
      ? "#fbbf24"
      : worker.active
        ? "#38bdf8"
        : "#34d399"
  context.beginPath()
  context.arc(42, 66, 9, 0, Math.PI * 2)
  context.fill()
  context.fillStyle = "#f8fafc"
  context.font = "600 34px Inter, system-ui, sans-serif"
  context.fillText(worker.name.slice(0, 25), 68, 59)
  context.fillStyle = "#a9bac8"
  context.font = "500 24px Inter, system-ui, sans-serif"
  context.fillText(worker.statusLabel.slice(0, 34), 68, 94)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  )
  sprite.scale.set(2.38, 0.49, 1)
  sprite.position.set(0, 2.34, 0)
  sprite.renderOrder = 20
  return sprite
}

function workerLabelSignature(worker: AgentOfficeWorker): string {
  return [worker.name, worker.statusLabel, worker.statusTone, worker.active].join("|")
}

function departmentLabelSignature(
  department: AgentOfficeDepartment,
  logicalAgentCount: number,
): string {
  return [
    department.name,
    department.activeCount,
    department.workers.length,
    logicalAgentCount,
  ].join("|")
}

function createDepartmentLabel(
  department: AgentOfficeDepartment,
  logicalAgentCount: number,
) {
  const canvas = document.createElement("canvas")
  canvas.width = 768
  canvas.height = 144
  const context = canvas.getContext("2d")
  if (!context) return null

  const isCeo = department.id === "ceo-office"
  context.fillStyle = isCeo ? "rgba(7, 17, 30, 0.96)" : "rgba(10, 24, 38, 0.92)"
  context.beginPath()
  context.roundRect(8, 8, 752, 128, 22)
  context.fill()
  context.strokeStyle = isCeo
    ? "rgba(129, 140, 248, 0.9)"
    : department.activeCount > 0
      ? "rgba(94, 225, 242, 0.82)"
      : "rgba(148, 163, 184, 0.48)"
  context.lineWidth = isCeo ? 5 : 3
  context.stroke()

  context.fillStyle = isCeo ? "#c7d2fe" : "#f8fafc"
  context.font = "700 37px Inter, system-ui, sans-serif"
  context.fillText(
    (isCeo ? `CEO · ${department.name}` : department.name).slice(0, 34),
    34,
    62,
  )
  context.fillStyle = department.activeCount > 0 ? "#67e8f9" : "#a7b7c7"
  context.font = "600 25px Inter, system-ui, sans-serif"
  const activeLabel = department.activeCount === 1 ? "1 activo" : `${department.activeCount} activos`
  context.fillText(
    `${activeLabel} · ${department.workers.length}/${logicalAgentCount} agentes`,
    34,
    105,
  )

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    }),
  )
  sprite.scale.set(isCeo ? 4.5 : 4.05, isCeo ? 0.85 : 0.76, 1)
  sprite.renderOrder = 18
  tagObject(sprite, { departmentId: department.id })
  return sprite
}

function addCeoCommandNexus(
  group: THREE.Group,
  zoneDepth: number,
  working: boolean,
) {
  const z = zoneDepth / 2 - 1.15
  const platform = new THREE.Mesh(
    new THREE.CylinderGeometry(1.12, 1.22, 0.12, 40),
    material(0x172b3b, 0.32, 0.48),
  )
  platform.position.set(0, 0.14, z)
  group.add(platform)

  const table = new THREE.Mesh(
    new THREE.CylinderGeometry(0.72, 0.84, 0.18, 32),
    material(0x314b5e, 0.22, 0.58),
  )
  table.position.set(0, 0.78, z)
  group.add(table)

  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.18, 0.56, 18),
    material(0x647887, 0.34, 0.56),
  )
  column.position.set(0, 0.48, z)
  group.add(column)

  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.82, 0.9, 48),
    new THREE.MeshBasicMaterial({
      color: working ? 0x67e8f9 : 0x818cf8,
      transparent: true,
      opacity: working ? 0.92 : 0.62,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  halo.rotation.x = -Math.PI / 2
  halo.position.set(0, 0.89, z)
  halo.renderOrder = 8
  group.add(halo)

  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.22, 0),
    new THREE.MeshBasicMaterial({
      color: working ? 0x67e8f9 : 0xa5b4fc,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    }),
  )
  core.position.set(0, 1.36, z)
  core.renderOrder = 9
  group.add(core)
}

function addStandbyCapacityMesh(
  scene: THREE.Scene,
  markers: readonly StandbyCapacityMarker[],
) {
  if (markers.length === 0) return null
  const mesh = new THREE.InstancedMesh(
    new THREE.CapsuleGeometry(0.1, 0.24, 3, 6),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x12283a,
      emissiveIntensity: 0.22,
      roughness: 0.62,
      metalness: 0.2,
      transparent: true,
      opacity: 0.42,
    }),
    markers.length,
  )
  const dummy = new THREE.Object3D()
  markers.forEach((marker, index) => {
    dummy.position.set(...marker.position)
    dummy.rotation.set(0, marker.rotationY, 0)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    mesh.setMatrixAt(index, dummy.matrix)
    mesh.setColorAt(index, new THREE.Color(marker.color))
  })
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.frustumCulled = true
  mesh.userData.agentOfficeCapacity = "standby"
  scene.add(mesh)
  return mesh
}

function addCompactWorkerMesh(
  scene: THREE.Scene,
  markers: readonly CompactWorkerMarker[],
): CompactWorkerMesh | null {
  if (markers.length === 0) return null
  const mesh = new THREE.InstancedMesh(
    new THREE.CapsuleGeometry(0.2, 0.62, 4, 8),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x102333,
      emissiveIntensity: 0.28,
      roughness: 0.58,
      metalness: 0.12,
    }),
    markers.length,
  )
  const dummy = new THREE.Object3D()
  const workers: AgentOfficeWorker[] = []
  const indexByWorkerId = new Map<string, number>()
  markers.forEach((marker, index) => {
    dummy.position.set(...marker.position)
    dummy.rotation.set(0, marker.rotationY, 0)
    dummy.scale.set(1, 1, 1)
    dummy.updateMatrix()
    mesh.setMatrixAt(index, dummy.matrix)
    mesh.setColorAt(index, new THREE.Color(compactWorkerColor(marker.worker)))
    workers.push(marker.worker)
    indexByWorkerId.set(marker.worker.id, index)
  })
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.frustumCulled = true
  mesh.userData.agentOfficeCompactWorkers = true
  mesh.userData.workerIds = workers.map((worker) => worker.id)
  mesh.userData.departmentIds = workers.map((worker) => worker.departmentId)
  scene.add(mesh)
  return { mesh, workers, indexByWorkerId }
}

function addWorker({
  sceneGroup,
  worker,
  x,
  z,
  workerIndex,
  zoneWidth,
  zoneDepth,
  showLabel,
}: {
  sceneGroup: THREE.Group
  worker: AgentOfficeWorker
  x: number
  z: number
  workerIndex: number
  zoneWidth: number
  zoneDepth: number
  showLabel: boolean
}): WorkerAnimation {
  const group = new THREE.Group()
  group.position.set(x, 0, z + 1.15)
  group.rotation.y = Math.PI

  const bodyMaterial = material(ACTIVITY_COLORS[worker.activity], 0.58, 0.08)
  const skinTones = [0xf0c59b, 0xd9a06f, 0xb97745, 0x7d4d2d, 0xc9a580, 0xa07050]
  const skinMaterial = material(skinTones[workerIndex % skinTones.length], 0.72, 0.04)
  const trousersMaterial = material(workerIndex % 2 === 0 ? 0x26384a : 0x35313f, 0.78, 0.06)
  const shoeMaterial = material(0x17191e, 0.84, 0.12)
  const hairColors = [0x171717, 0x4b342b, 0x6b5040, 0x8a6a4a, 0x2a2a2a, 0x5a3a20]
  const hairMaterial = material(hairColors[workerIndex % hairColors.length], 0.88, 0.02)

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.5, 6, 12), bodyMaterial)
  body.position.y = 1.23
  group.add(body)

  const shirtFront = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.32, 0.025),
    material(0xe8eef1, 0.82),
  )
  shirtFront.position.set(0, 1.39, 0.246)
  group.add(shirtFront)

  const badgeMaterial = new THREE.MeshBasicMaterial({
    color: STATUS_COLORS[worker.statusTone],
  })
  const badge = new THREE.Mesh(
    new THREE.BoxGeometry(0.095, 0.13, 0.02),
    badgeMaterial,
  )
  badge.position.set(0.13, 1.43, 0.267)
  group.add(badge)

  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.085, 0.095, 0.17, 10),
    skinMaterial,
  )
  neck.position.y = 1.68
  group.add(neck)

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 18, 14), skinMaterial)
  head.position.y = 1.82
  group.add(head)

  const eyeMaterial = material(0x111827, 0.78, 0.06)
  for (const eyeX of [-0.075, 0.075]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), eyeMaterial)
    eye.position.set(eyeX, 1.85, 0.215)
    group.add(eye)
    const eyeWhite = new THREE.Mesh(
      new THREE.SphereGeometry(0.034, 10, 8),
      material(0xf0f4f8, 0.4, 0.02),
    )
    eyeWhite.position.set(eyeX, 1.85, 0.21)
    eyeWhite.scale.set(1, 0.7, 0.5)
    group.add(eyeWhite)
  }

  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.235, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.58),
    hairMaterial,
  )
  hair.position.y = 1.88
  group.add(hair)

  const statusHaloMaterial = new THREE.MeshBasicMaterial({
    color: STATUS_COLORS[worker.statusTone],
    transparent: true,
    opacity: worker.active ? 0.95 : 0.55,
    side: THREE.DoubleSide,
  })
  const statusHalo = new THREE.Mesh(
    new THREE.RingGeometry(0.27, 0.33, 20),
    statusHaloMaterial,
  )
  statusHalo.position.y = 2.12
  statusHalo.rotation.x = Math.PI / 2
  group.add(statusHalo)

  const leftArm = new THREE.Group()
  leftArm.position.set(-0.32, 1.52, 0)
  leftArm.rotation.z = 0.12
  const leftArmMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.42, 4, 8), bodyMaterial)
  leftArmMesh.position.y = -0.25
  leftArm.add(leftArmMesh)
  const leftHand = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), skinMaterial)
  leftHand.position.y = -0.53
  leftArm.add(leftHand)
  group.add(leftArm)

  const rightArm = leftArm.clone(true)
  rightArm.position.x = 0.32
  rightArm.rotation.z = -0.12
  group.add(rightArm)

  const leftLeg = new THREE.Group()
  leftLeg.position.set(-0.14, 0.87, 0)
  const leftLegMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.52, 4, 8), trousersMaterial)
  leftLegMesh.position.y = -0.31
  leftLeg.add(leftLegMesh)
  const leftShoe = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.13, 0.34), shoeMaterial)
  leftShoe.position.set(0, -0.66, 0.09)
  leftLeg.add(leftShoe)
  group.add(leftLeg)
  const rightLeg = leftLeg.clone(true)
  rightLeg.position.x = 0.14
  group.add(rightLeg)

  const selectionRing = new THREE.Mesh(
    new THREE.RingGeometry(0.48, 0.58, 28),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
  )
  selectionRing.position.y = 0.025
  selectionRing.rotation.x = -Math.PI / 2
  selectionRing.visible = false
  group.add(selectionRing)

  // Give each moving worker a forgiving, invisible hit area. Raycasting only
  // against the visible body made clicks near an arm or between animation
  // frames fall through to the department carpet, opening the department
  // instead of the worker activity panel.
  const interactionTarget = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.52, 1.18, 4, 8),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
    }),
  )
  interactionTarget.position.y = 1.18
  interactionTarget.userData.agentOfficeInteractionTarget = true
  interactionTarget.visible = false
  group.add(interactionTarget)

  const label = showLabel ? createWorkerLabel(worker) : null
  if (label) group.add(label)

  const routeOffset = ((workerIndex % 3) - 1) * 0.42
  const route = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(x, 0, z + 1.15),
      new THREE.Vector3(
        THREE.MathUtils.clamp(x + 1.2 + routeOffset, -zoneWidth / 2 + 1.4, zoneWidth / 2 - 1.4),
        0,
        zoneDepth / 2 - 1.35,
      ),
      new THREE.Vector3(zoneWidth / 2 - 1.4, 0, routeOffset),
      new THREE.Vector3(routeOffset, 0, -zoneDepth / 2 + 2.2),
      new THREE.Vector3(-zoneWidth / 2 + 1.4, 0, -routeOffset),
      new THREE.Vector3(
        THREE.MathUtils.clamp(x - 1.15 - routeOffset, -zoneWidth / 2 + 1.4, zoneWidth / 2 - 1.4),
        0,
        zoneDepth / 2 - 1.4,
      ),
    ],
    true,
    "catmullrom",
    0.18,
  )

  tagObject(group, { workerId: worker.id, departmentId: worker.departmentId })
  sceneGroup.add(group)

  return {
    worker,
    stance: officeWorkerStance(worker),
    group,
    head,
    leftArm,
    rightArm,
    leftLeg,
    rightLeg,
    screen: null as unknown as WorkerAnimation["screen"],
    secondaryScreen: null as unknown as WorkerAnimation["secondaryScreen"],
    edgeGlowMaterial: null as unknown as WorkerAnimation["edgeGlowMaterial"],
    lampGlowMaterial: null as unknown as WorkerAnimation["lampGlowMaterial"],
    activeBeacon: null as unknown as WorkerAnimation["activeBeacon"],
    interactionTarget,
    badgeMaterial,
    statusHaloMaterial,
    label,
    labelSignature: label ? workerLabelSignature(worker) : null,
    selectionRing,
    walkPath: route,
    walkSpeed: worker.statusTone === "attention" ? 0.038 : 0.03,
    locomotion: officeWorkerStance(worker) !== "working" && workerIndex % 3 === 0,
    phase: workerIndex * 1.37,
    baseY: group.position.y,
    standPosition: new THREE.Vector3(x, 0, z + 1.15),
    // The chair addChair() puts in front of this desk. A running agent walks
    // the last step to it and sits, so the desk it occupies is the one whose
    // screen is lit.
    seatPosition: new THREE.Vector3(x, SEAT_HIP_DROP, z + SEAT_FORWARD_OFFSET),
  }
}

function disposeObjectResources(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const current of materials) {
      for (const value of Object.values(current)) {
        if (value instanceof THREE.Texture) value.dispose()
      }
      current.dispose()
    }
  })
}

function disposeScene(scene: THREE.Scene) {
  disposeObjectResources(scene)
}

function officeSceneTopologySignature(model: AgentOfficeModel): string {
  return JSON.stringify(
    model.departments.map((department) => ({
      id: department.id,
      name: department.name,
      poolSize: department.pool.size,
      workers: department.workers.map((worker) => ({
        id: worker.id,
        name: worker.name,
        departmentId: worker.departmentId,
        activity: worker.activity,
      })),
    })),
  )
}

function officeSceneLiveSignature(model: AgentOfficeModel): string {
  return JSON.stringify(
    model.departments.map((department) => ({
      id: department.id,
      activeCount: department.activeCount,
      workers: department.workers.map((worker) => ({
        id: worker.id,
        statusLabel: worker.statusLabel,
        statusTone: worker.statusTone,
        active: worker.active,
        blocker: worker.blocker,
      })),
    })),
  )
}

function runCameraCommand(
  controls: AgentOfficeCameraControls,
  command: AgentOfficeCameraCommand,
) {
  if (command.type === "reset") controls.reset()
  else if (command.type === "zoom-in") controls.zoomIn()
  else controls.zoomOut()
}

export function AgentOfficeScene({
  model,
  variant = "full",
  paused = false,
  timeOfDay,
  timePhase,
  selectedWorkerId = null,
  cameraCommand = null,
  className,
  onSelectWorker,
  onSelectDepartment,
  onReady,
}: AgentOfficeSceneProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const pausedRef = React.useRef(paused)
  const selectedWorkerRef = React.useRef(selectedWorkerId)
  const selectWorkerRef = React.useRef(onSelectWorker)
  const selectDepartmentRef = React.useRef(onSelectDepartment)
  const onReadyRef = React.useRef(onReady)
  const cameraControlsRef = React.useRef<AgentOfficeCameraControls | null>(null)
  const invalidateSceneRef = React.useRef<(() => void) | null>(null)
  const liveSceneUpdateRef = React.useRef<((nextModel: AgentOfficeModel) => void) | null>(null)
  const latestCameraCommandRef = React.useRef(cameraCommand)
  const cameraControlsGenerationRef = React.useRef(0)
  const lastAppliedCameraCommandRef = React.useRef<{
    nonce: number
    generation: number
  } | null>(null)
  const modelRef = React.useRef(model)
  const [failed, setFailed] = React.useState(false)
  const topologySignature = React.useMemo(() => officeSceneTopologySignature(model), [model])
  const liveSignature = React.useMemo(() => officeSceneLiveSignature(model), [model])
  const cameraCommandType = cameraCommand?.type
  const cameraCommandNonce = cameraCommand?.nonce
  const officePopulation = React.useMemo(
    () => buildAgentOfficeLayout(
      model.departments.map((department) => ({
        id: department.id,
        workerCount: department.workers.length,
        logicalAgentCount: Math.max(
          department.workers.length,
          department.pool.size,
        ),
      })),
      "full",
    ),
    [model],
  )

  modelRef.current = model
  latestCameraCommandRef.current = cameraCommand

  React.useEffect(() => {
    pausedRef.current = paused
    invalidateSceneRef.current?.()
  }, [paused])

  React.useEffect(() => {
    selectedWorkerRef.current = selectedWorkerId
    invalidateSceneRef.current?.()
  }, [selectedWorkerId])

  React.useEffect(() => {
    liveSceneUpdateRef.current?.(model)
    invalidateSceneRef.current?.()
  }, [liveSignature, model])

  React.useEffect(() => {
    selectWorkerRef.current = onSelectWorker
    selectDepartmentRef.current = onSelectDepartment
    onReadyRef.current = onReady
  }, [onReady, onSelectDepartment, onSelectWorker])

  React.useEffect(() => {
    const controls = cameraControlsRef.current
    const command = latestCameraCommandRef.current
    if (!controls || !command) return
    const generation = cameraControlsGenerationRef.current
    const lastApplied = lastAppliedCameraCommandRef.current
    if (lastApplied?.nonce === command.nonce && lastApplied.generation === generation) return
    runCameraCommand(controls, command)
    lastAppliedCameraCommandRef.current = { nonce: command.nonce, generation }
  }, [cameraCommandNonce, cameraCommandType])

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const resolvedPhase = timePhase || (timeOfDay ? (timeOfDay as OfficeTimePhase) : officeTimePhase())
    // The phase always refines the day/night structure, so deriving one from
    // the other can never light a starfield with a sunset.
    const resolvedTimeOfDay: OfficeTimeOfDay = resolvedPhase === "night" ? "night" : "day"
    const night = resolvedTimeOfDay === "night"
    const interiorLighting = night || resolvedPhase === "dusk" || resolvedPhase === "dawn"
    const light = PHASE_LIGHTING[resolvedPhase]

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: variant === "full",
        alpha: false,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false,
      })
    } catch {
      setFailed(true)
      return
    }

    setFailed(false)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = light.exposure
    renderer.setClearColor(light.fog, 1)
    const pixelRatioCap =
      variant === "thumbnail" ? 1 : window.innerWidth < 640 ? 1.35 : 1.7
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap))
    renderer.shadowMap.enabled = variant === "full"
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.domElement.className = "block h-full w-full touch-none"
    renderer.domElement.setAttribute("aria-label", "Oficina 3D de agentes y departamentos")
    renderer.domElement.dataset.officeCanvas = variant
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()

    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 280)
    const target = new THREE.Vector3(0, 0, 0)
    let yaw = -0.72
    let pitch = 0.72
    let distance = 42

    const sceneModel = modelRef.current
    // Full mode is operational truth: never hide an empty department and never
    // slice the company. Thumbnail remains intentionally bounded.
    const departments = selectAgentOfficeDepartments(
      sceneModel.departments,
      variant,
    )
    const layout = buildAgentOfficeLayout(
      departments.map((department) => ({
        id: department.id,
        workerCount: department.workers.length,
        logicalAgentCount: Math.max(
          department.workers.length,
          department.pool.size,
        ),
      })),
      variant,
    )
    const standbyAllocation = allocateAgentOfficeStandbyMarkers(layout, variant)
    const companyInteractiveWorkerCount = sceneModel.departments.reduce(
      (sum, department) => sum + department.workers.length,
      0,
    )
    const companyLogicalAgentCount = sceneModel.departments.reduce(
      (sum, department) => sum + Math.max(department.workers.length, department.pool.size),
      0,
    )
    const companyStandbyAgentCount = Math.max(
      0,
      companyLogicalAgentCount - companyInteractiveWorkerCount,
    )
    const {
      zoneWidth,
      zoneDepth,
      totalWidth,
      totalDepth,
    } = layout

    host.dataset.officeDepartmentCount = String(sceneModel.departments.length)
    host.dataset.officeRenderedDepartmentCount = String(layout.departmentCount)
    host.dataset.officeLogicalAgentCount = String(companyLogicalAgentCount)
    host.dataset.officeRenderedLogicalAgentCount = String(layout.logicalAgentCount)
    host.dataset.officeInteractiveWorkerCount = String(companyInteractiveWorkerCount)
    host.dataset.officeRenderedInteractiveWorkerCount = String(layout.interactiveWorkerCount)
    host.dataset.officeStandbyAgentCount = String(companyStandbyAgentCount)
    host.dataset.officeRenderedStandbyAgentCount = String(layout.standbyAgentCount)
    host.dataset.officeStandbyRenderedCount = String(standbyAllocation.rendered)
    host.dataset.officeStandbyOverflowCount = String(standbyAllocation.overflow)
    host.dataset.officeCeoCentral = departments.some((department) => department.id === "ceo-office")
      ? "true"
      : "false"

    const edgeDistrict = addEdgeDistrict({
      scene,
      totalWidth,
      totalDepth,
      timeOfDay: resolvedTimeOfDay,
      timePhase: resolvedPhase,
      light,
      variant,
    })
    camera.far = Math.max(
      280,
      edgeDistrict.framing.portraitDistance * 3,
      edgeDistrict.framing.maxDistance * 2.4,
      Math.abs(edgeDistrict.framing.groundY) * 2.8,
      edgeDistrict.counts.tallestBuildingHeight * 2.2,
      totalWidth * 3,
      totalDepth * 3,
    )
    camera.updateProjectionMatrix()
    renderer.domElement.dataset.cityBuildingCount = String(edgeDistrict.counts.buildings)
    renderer.domElement.dataset.citySignatureTowerCount = String(edgeDistrict.counts.signatureTowers)
    renderer.domElement.dataset.cityArchitecturalCrownCount = String(edgeDistrict.counts.architecturalCrowns)
    renderer.domElement.dataset.cityGlassFacadeCount = String(edgeDistrict.counts.glassFacades)
    renderer.domElement.dataset.cityTerraceAmenityCount = String(edgeDistrict.counts.terraceAmenities)
    renderer.domElement.dataset.cityTallestBuildingHeight = edgeDistrict.counts.tallestBuildingHeight.toFixed(1)
    renderer.domElement.dataset.cityWindowCount = String(edgeDistrict.counts.windows)
    renderer.domElement.dataset.cityTreeCount = String(edgeDistrict.counts.trees)
    renderer.domElement.dataset.cityMoverCount = String(edgeDistrict.counts.vehicles)
    renderer.domElement.dataset.cityLightCount = String(edgeDistrict.counts.lightFixtures)
    renderer.domElement.dataset.hqStackedFloors = String(edgeDistrict.counts.hqStackedFloors)
    renderer.domElement.dataset.hqFloorHeight = String(edgeDistrict.counts.hqFloorHeight)
    renderer.domElement.dataset.rooftopOffice = "true"
    host.dataset.cityBuildingCount = String(edgeDistrict.counts.buildings)
    host.dataset.hqStackedFloors = String(edgeDistrict.counts.hqStackedFloors)
    host.dataset.hqFloorHeight = String(edgeDistrict.counts.hqFloorHeight)

    let needsRender = true
    let animationFrame = 0
    const scheduleFrame = () => {
      if (animationFrame === 0) {
        animationFrame = window.requestAnimationFrame(animate)
      }
    }
    const invalidate = () => {
      needsRender = true
      scheduleFrame()
    }
    invalidateSceneRef.current = invalidate
    const maxCameraDistance = Math.max(
      edgeDistrict.framing.maxDistance,
      edgeDistrict.framing.portraitDistance * 1.18,
    )

    const updateCamera = () => {
      const horizontal = Math.cos(pitch) * distance
      camera.position.set(
        target.x + Math.sin(yaw) * horizontal,
        target.y + Math.sin(pitch) * distance,
        target.z + Math.cos(yaw) * horizontal,
      )
      camera.lookAt(target)
      invalidate()
    }

    const resetCamera = () => {
      const aspect = Math.max(0.35, host.clientWidth / Math.max(1, host.clientHeight))
      const portraitMix = 1 - THREE.MathUtils.smoothstep(aspect, 0.62, 1.12)
      camera.fov = THREE.MathUtils.lerp(36, variant === "thumbnail" ? 48 : 54, portraitMix)
      camera.updateProjectionMatrix()
      yaw = edgeDistrict.framing.yaw
      pitch = THREE.MathUtils.lerp(
        edgeDistrict.framing.pitch,
        edgeDistrict.framing.portraitPitch,
        portraitMix,
      )
      distance = THREE.MathUtils.lerp(
        edgeDistrict.framing.landscapeDistance,
        edgeDistrict.framing.portraitDistance,
        portraitMix,
      )
      target.copy(edgeDistrict.framing.target)
      target.y += portraitMix * edgeDistrict.framing.portraitTargetLift
      updateCamera()
    }
    const zoomCamera = (factor: number) => {
      distance = THREE.MathUtils.clamp(
        distance * factor,
        edgeDistrict.framing.minDistance,
        maxCameraDistance,
      )
      updateCamera()
    }
    cameraControlsRef.current = {
      reset: resetCamera,
      zoomIn: () => zoomCamera(0.82),
      zoomOut: () => zoomCamera(1.22),
    }
    cameraControlsGenerationRef.current += 1
    resetCamera()
    const pendingCameraCommand = latestCameraCommandRef.current
    const controlsGeneration = cameraControlsGenerationRef.current
    const lastAppliedCameraCommand = lastAppliedCameraCommandRef.current
    if (
      pendingCameraCommand
      && (
        lastAppliedCameraCommand?.nonce !== pendingCameraCommand.nonce
        || lastAppliedCameraCommand.generation !== controlsGeneration
      )
    ) {
      runCameraCommand(cameraControlsRef.current, pendingCameraCommand)
      lastAppliedCameraCommandRef.current = {
        nonce: pendingCameraCommand.nonce,
        generation: controlsGeneration,
      }
    }

    const hemisphere = new THREE.HemisphereLight(
      light.hemisphereSky,
      light.hemisphereGround,
      light.hemisphereIntensity,
    )
    scene.add(hemisphere)
    const sun = new THREE.DirectionalLight(light.sunColor, light.sunIntensity)
    sun.position.set(...light.sunPosition)
    sun.castShadow = variant === "full"
    if (variant === "full") {
      const shadowExtent = Math.max(30, totalWidth * 0.54, totalDepth * 0.54)
      const shadowMapSize = layout.departmentCount > 24 ? 1024 : 2048
      sun.shadow.mapSize.set(shadowMapSize, shadowMapSize)
      sun.shadow.camera.left = -shadowExtent
      sun.shadow.camera.right = shadowExtent
      sun.shadow.camera.top = shadowExtent
      sun.shadow.camera.bottom = -shadowExtent
      sun.shadow.bias = -0.00018
      sun.shadow.normalBias = 0.025
      sun.shadow.radius = 2
    }
    scene.add(sun)
    const fill = new THREE.DirectionalLight(light.fillColor, light.fillIntensity)
    fill.position.set(18, 12, -16)
    scene.add(fill)
    const rim = new THREE.DirectionalLight(
      resolvedPhase === "dusk" ? 0xffc49b : night ? 0x8dd8ea : 0xdff7ff,
      resolvedPhase === "dusk" || night ? 0.72 : 0.46,
    )
    rim.position.set(-22, 9, -24)
    scene.add(rim)
    if (interiorLighting) {
      const urbanBounce = new THREE.DirectionalLight(
        resolvedPhase === "dusk" ? 0xffad72 : 0xffd39b,
        resolvedPhase === "dusk" ? 0.38 : 0.24,
      )
      urbanBounce.position.set(4, 5, 26)
      scene.add(urbanBounce)
    }

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(totalWidth + 10, totalDepth + 10),
      new THREE.MeshPhysicalMaterial({
        color: light.floor,
        roughness: 0.72,
        metalness: 0.08,
        clearcoat: 0.16,
        clearcoatRoughness: 0.58,
      }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.08
    floor.receiveShadow = variant === "full"
    scene.add(floor)

    const aisle = new THREE.Mesh(
      new THREE.PlaneGeometry(totalWidth + 6, 1.15),
      material(night ? 0x7d898e : 0xc7d1d5, 0.9),
    )
    aisle.rotation.x = -Math.PI / 2
    aisle.position.set(0, -0.035, totalDepth / 2 + 1.6)
    scene.add(aisle)

    const aisleAccent = new THREE.Mesh(
      new THREE.PlaneGeometry(totalWidth + 5.2, 0.075),
      new THREE.MeshBasicMaterial({
        color: interiorLighting ? 0x77d6e6 : 0x4f8793,
        transparent: true,
        opacity: interiorLighting ? 0.88 : 0.54,
      }),
    )
    aisleAccent.rotation.x = -Math.PI / 2
    aisleAccent.position.set(0, -0.018, totalDepth / 2 + 1.6)
    aisleAccent.renderOrder = 4
    scene.add(aisleAccent)

    const workers: WorkerAnimation[] = []
    const departmentAnimations: DepartmentAnimation[] = []
    const workerSelectables: THREE.Object3D[] = []
    const departmentSelectables: THREE.Object3D[] = []
    const standbyMarkers: StandbyCapacityMarker[] = []
    const compactWorkerMarkers: CompactWorkerMarker[] = []
    const detailedIds = detailedWorkerIds(departments, variant)
    const placementById = new Map(
      layout.placements.map((placement) => [placement.id, placement] as const),
    )
    const layoutDepartmentById = new Map(
      layout.departments.map((department) => [department.id, department] as const),
    )
    const litDepartmentIds = new Set(
      [...departments]
        .sort((left, right) => (
          Number(right.id === "ceo-office") - Number(left.id === "ceo-office")
          || right.activeCount - left.activeCount
        ))
        .slice(0, 12)
        .map((department) => department.id),
    )

    departments.forEach((department, departmentIndex) => {
      const placement = placementById.get(department.id)
      if (!placement) return
      const zoneX = placement.x
      const zoneZ = placement.z
      const isCeo = placement.isCeo
      const departmentGroup = new THREE.Group()
      departmentGroup.position.set(zoneX, 0, zoneZ)

      const working = department.activeCount > 0
      let workLight: THREE.PointLight | null = null
      const workLightIntensity = working ? (night ? 8.2 : 5.6) : night ? 4.8 : 3.4
      if (interiorLighting && litDepartmentIds.has(department.id)) {
        workLight = new THREE.PointLight(
          working ? 0xddeaff : 0xffd7a1,
          workLightIntensity,
          Math.max(zoneWidth, zoneDepth) * 1.15,
          1.8,
        )
        workLight.position.set(0, 4.1, 0)
        departmentGroup.add(workLight)
      }

      const carpet = new THREE.Mesh(
        new THREE.BoxGeometry(zoneWidth, isCeo ? 0.08 : 0.055, zoneDepth),
        material(isCeo ? 0x1e3042 : 0x4f5a61, 0.86, isCeo ? 0.12 : 0.02),
      )
      carpet.position.y = isCeo ? -0.005 : -0.018
      carpet.receiveShadow = variant === "full"
      tagObject(carpet, { departmentId: department.id })
      departmentGroup.add(carpet)
      departmentSelectables.push(carpet)

      const stripeColor = ACTIVITY_COLORS[department.workers[0]?.activity || (department.id === "ceo-office" ? "coordination" : "software")]
      const zoneEdgeMaterial = new THREE.MeshStandardMaterial({
        color: isCeo ? 0xa5b4fc : working ? 0x9ddce8 : 0x8f9ca2,
        roughness: 0.48,
        metalness: 0.24,
      })
      const zoneEdges = [
        { x: 0, z: -zoneDepth / 2, width: zoneWidth, depth: 0.07 },
        { x: 0, z: zoneDepth / 2, width: zoneWidth, depth: 0.07 },
        { x: -zoneWidth / 2, z: 0, width: 0.07, depth: zoneDepth },
        { x: zoneWidth / 2, z: 0, width: 0.07, depth: zoneDepth },
      ]
      zoneEdges.forEach((edge) => {
        const trim = new THREE.Mesh(
          new THREE.BoxGeometry(edge.width, 0.045, edge.depth),
          zoneEdgeMaterial,
        )
        trim.position.set(edge.x, 0.075, edge.z)
        departmentGroup.add(trim)
      })

      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(zoneWidth - 0.45, 0.025, 0.12),
        new THREE.MeshBasicMaterial({ color: stripeColor }),
      )
      stripe.position.set(0, 0.07, -zoneDepth / 2 + 0.23)
      departmentGroup.add(stripe)

      if (isCeo && variant === "full") {
        addCeoCommandNexus(departmentGroup, zoneDepth, working)
      }

      const visibleWorkers = variant === "thumbnail"
        ? department.workers.slice(0, 5)
        : department.workers
      const deskGrid = buildAgentOfficeDeskGrid(
        visibleWorkers.length,
        zoneWidth,
        zoneDepth,
        variant,
      )
      const deskCount = deskGrid.count
      const deskColumns = deskGrid.columns
      const deskRows = deskGrid.rows
      const spacingX = deskGrid.spacingX
      const spacingZ = deskGrid.spacingZ

      for (let deskIndex = 0; deskIndex < deskCount; deskIndex += 1) {
        const deskColumn = deskIndex % deskColumns
        const deskRow = Math.floor(deskIndex / deskColumns)
        const deskX = (deskColumn - (deskColumns - 1) / 2) * spacingX
        const deskZ = (deskRow - (deskRows - 1) / 2) * spacingZ - 0.15
        const worker = visibleWorkers[deskIndex]
        const detailed = Boolean(worker && detailedIds.has(worker.id))
        const station = !worker || detailed
          ? addDesk(departmentGroup, deskX, deskZ, Boolean(worker?.active))
          : null
        if (!worker || detailed) addChair(departmentGroup, deskX, deskZ + 0.88)
        if (worker && detailed && station) {
          const animation = addWorker({
            sceneGroup: departmentGroup,
            worker,
            x: deskX,
            z: deskZ,
            workerIndex: workers.length,
            zoneWidth,
            zoneDepth,
            showLabel:
              variant === "full" &&
              (worker.active || worker.statusTone === "attention"),
          })
          animation.screen = station.primaryScreen
          animation.secondaryScreen = station.secondaryScreen
          animation.edgeGlowMaterial = station.edgeGlowMaterial
          animation.lampGlowMaterial = station.lampGlowMaterial
          animation.activeBeacon = station.activeBeacon
          workers.push(animation)
          workerSelectables.push(animation.interactionTarget)
        } else if (worker) {
          compactWorkerMarkers.push({
            worker,
            position: [zoneX + deskX, 0.76, zoneZ + deskZ + 1.15],
            rotationY: Math.PI,
          })
        }
      }

      const board = new THREE.Mesh(
        new THREE.BoxGeometry(Math.min(3.6, zoneWidth - 1.1), 1.7, 0.14),
        material(0x203750, 0.48, 0.12),
      )
      board.position.set(0, 1.18, -zoneDepth / 2 + 0.32)
      tagObject(board, { departmentId: department.id })
      departmentGroup.add(board)
      departmentSelectables.push(board)

      const boardMaterial = new THREE.MeshStandardMaterial({
        color: working ? stripeColor : 0x8aa0b2,
        emissive: working ? stripeColor : 0x1f2937,
        emissiveIntensity: working ? 0.42 : 0.08,
        roughness: 0.4,
      })
      const boardLight = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.min(3.25, zoneWidth - 1.45), 1.35),
        boardMaterial,
      )
      boardLight.position.set(0, 1.18, -zoneDepth / 2 + 0.395)
      tagObject(boardLight, { departmentId: department.id })
      departmentGroup.add(boardLight)
      departmentSelectables.push(boardLight)

      const boardWidth = Math.min(3.25, zoneWidth - 1.45)
      for (let lineIndex = 0; lineIndex < 3; lineIndex += 1) {
        const line = new THREE.Mesh(
          new THREE.PlaneGeometry(boardWidth * (0.7 - lineIndex * 0.09), 0.055),
          new THREE.MeshBasicMaterial({
            color: lineIndex === 0 ? 0xf5fbff : 0xc8e0e7,
            transparent: true,
            opacity: working ? 0.82 : 0.42,
            depthWrite: false,
          }),
        )
        line.position.set(
          -boardWidth * (0.08 + lineIndex * 0.025),
          1.45 - lineIndex * 0.27,
          -zoneDepth / 2 + 0.472,
        )
        departmentGroup.add(line)
      }
      const boardStatusMaterial = new THREE.MeshBasicMaterial({
        color: working ? STATUS_COLORS.active : STATUS_COLORS.ready,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      })
      const boardStatus = new THREE.Mesh(
        new THREE.CircleGeometry(0.1, 18),
        boardStatusMaterial,
      )
      boardStatus.position.set(
        boardWidth * 0.37,
        1.52,
        -zoneDepth / 2 + 0.476,
      )
      departmentGroup.add(boardStatus)

      const layoutDepartment = layoutDepartmentById.get(department.id)
      const logicalAgentCount = layoutDepartment?.logicalAgentCount || department.workers.length
      let departmentLabel: THREE.Sprite | null = null
      if (variant === "full") {
        departmentLabel = createDepartmentLabel(department, logicalAgentCount)
        if (departmentLabel) {
          departmentLabel.position.set(0, 2.48, -zoneDepth / 2 + 0.5)
          departmentGroup.add(departmentLabel)
          departmentSelectables.push(departmentLabel)
        }
      }

      // Logical capacity is deliberately neutral and static. These lightweight
      // instanced markers are empty standby positions, never fake active people.
      const standbyCount = standbyAllocation.byDepartment.get(department.id) || 0
      const markerColumns = Math.max(
        1,
        Math.min(16, Math.floor((zoneWidth - 1.1) / 0.36)),
      )
      for (let markerIndex = 0; markerIndex < standbyCount; markerIndex += 1) {
        const column = markerIndex % markerColumns
        const row = Math.floor(markerIndex / markerColumns)
        const centeredColumn =
          (column - (Math.min(markerColumns, standbyCount) - 1) / 2) * 0.36
        standbyMarkers.push({
          position: isCeo
            ? [
                zoneX - zoneWidth / 2 + 0.42 + row * 0.36,
                0.28,
                zoneZ + centeredColumn,
              ]
            : [
                zoneX + centeredColumn,
                0.28,
                zoneZ + zoneDepth / 2 - 0.42 - row * 0.36,
              ],
          rotationY: Math.PI,
          color: isCeo ? 0xa5b4fc : 0x91a8b8,
        })
      }

      // Shift-work pulse on the carpet. It only ever runs for a department
      // with live agents, so "this floor started working" reads from across
      // the office even before you look at which desks are occupied.
      const pulse = new THREE.Mesh(
        new THREE.RingGeometry(0.92, 1.12, 40),
        new THREE.MeshBasicMaterial({
          color: stripeColor,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      )
      pulse.rotation.x = -Math.PI / 2
      pulse.position.y = 0.075
      pulse.visible = working
      pulse.renderOrder = 3
      departmentGroup.add(pulse)

      departmentAnimations.push({
        departmentId: department.id,
        group: departmentGroup,
        working,
        activeColor: stripeColor,
        boardMaterial,
        boardStatusMaterial,
        workLight,
        workLightIntensity,
        pulse,
        label: departmentLabel,
        labelSignature: departmentLabel
          ? departmentLabelSignature(department, logicalAgentCount)
          : null,
        logicalAgentCount,
        labelPosition: new THREE.Vector3(0, 2.48, -zoneDepth / 2 + 0.5),
        phase: departmentIndex * 0.83,
      })

      scene.add(departmentGroup)
    })

    const compactWorkerMesh = addCompactWorkerMesh(scene, compactWorkerMarkers)
    if (compactWorkerMesh) workerSelectables.push(compactWorkerMesh.mesh)
    addStandbyCapacityMesh(scene, standbyMarkers)
    const renderedInteractiveWorkerCount = workers.length + compactWorkerMarkers.length
    renderer.domElement.dataset.officeDepartmentCount = String(sceneModel.departments.length)
    renderer.domElement.dataset.officeRenderedDepartmentCount = String(layout.departmentCount)
    renderer.domElement.dataset.officeLogicalAgentCount = String(companyLogicalAgentCount)
    renderer.domElement.dataset.officeRenderedLogicalAgentCount = String(layout.logicalAgentCount)
    renderer.domElement.dataset.officeInteractiveWorkerCount = String(companyInteractiveWorkerCount)
    renderer.domElement.dataset.officeRenderedInteractiveWorkerCount = String(renderedInteractiveWorkerCount)
    renderer.domElement.dataset.officeDetailedWorkerCount = String(workers.length)
    renderer.domElement.dataset.officeCompactWorkerCount = String(compactWorkerMarkers.length)
    renderer.domElement.dataset.workerCount = String(renderedInteractiveWorkerCount)
    renderer.domElement.dataset.officeStandbyAgentCount = String(companyStandbyAgentCount)
    renderer.domElement.dataset.officeRenderedStandbyAgentCount = String(layout.standbyAgentCount)
    renderer.domElement.dataset.officeStandbyRenderedCount = String(standbyMarkers.length)
    renderer.domElement.dataset.officeStandbyOverflowCount = String(standbyAllocation.overflow)

    const updateLiveScene = (nextModel: AgentOfficeModel) => {
      const nextWorkers = new Map(
        nextModel.departments.flatMap((department) => department.workers)
          .map((worker) => [worker.id, worker] as const),
      )
      workers.forEach((animation, workerIndex) => {
        const nextWorker = nextWorkers.get(animation.worker.id)
        if (!nextWorker) return

        animation.worker = nextWorker
        animation.stance = officeWorkerStance(nextWorker)
        animation.locomotion = animation.stance !== "working" && workerIndex % 3 === 0
        animation.walkSpeed = nextWorker.statusTone === "attention" ? 0.038 : 0.03
        animation.badgeMaterial.color.setHex(STATUS_COLORS[nextWorker.statusTone])
        animation.statusHaloMaterial.color.setHex(STATUS_COLORS[nextWorker.statusTone])
        animation.statusHaloMaterial.opacity = nextWorker.active ? 0.95 : 0.55
        applyAgentOfficeWorkerStationVisualState({
          screens: [animation.screen, animation.secondaryScreen],
          edgeGlowMaterial: animation.edgeGlowMaterial,
          lampGlowMaterial: animation.lampGlowMaterial,
          activeBeacon: animation.activeBeacon,
        }, nextWorker.active)

        const nextLabelSignature = workerLabelSignature(nextWorker)
        const shouldShowLabel =
          variant === "full"
          && (nextWorker.active || nextWorker.statusTone === "attention")
        if (
          animation.label
          && (!shouldShowLabel || animation.labelSignature !== nextLabelSignature)
        ) {
          animation.group.remove(animation.label)
          disposeObjectResources(animation.label)
          animation.label = null
          animation.labelSignature = null
        }
        if (shouldShowLabel && !animation.label) {
          const nextLabel = createWorkerLabel(nextWorker)
          if (nextLabel) {
            animation.group.add(nextLabel)
            animation.label = nextLabel
            animation.labelSignature = nextLabelSignature
          }
        }
      })

      if (compactWorkerMesh) {
        let compactColorsChanged = false
        compactWorkerMesh.workers.forEach((worker, index) => {
          const nextWorker = nextWorkers.get(worker.id)
          if (!nextWorker) return
          compactWorkerMesh.workers[index] = nextWorker
          compactWorkerMesh.mesh.setColorAt(
            index,
            new THREE.Color(compactWorkerColor(nextWorker)),
          )
          compactColorsChanged = true
        })
        if (compactColorsChanged && compactWorkerMesh.mesh.instanceColor) {
          compactWorkerMesh.mesh.instanceColor.needsUpdate = true
        }
      }

      const nextDepartments = new Map(
        nextModel.departments.map((department) => [department.id, department] as const),
      )
      for (const animation of departmentAnimations) {
        const nextDepartment = nextDepartments.get(animation.departmentId)
        if (!nextDepartment) continue
        const working = nextDepartment.activeCount > 0
        animation.working = working
        animation.workLightIntensity = working ? (night ? 8.2 : 5.6) : night ? 4.8 : 3.4
        animation.pulse.visible = working
        animation.boardMaterial.color.setHex(working ? animation.activeColor : 0x8aa0b2)
        animation.boardMaterial.emissive.setHex(working ? animation.activeColor : 0x1f2937)
        animation.boardMaterial.emissiveIntensity = working ? 0.42 : 0.08
        animation.boardStatusMaterial.color.setHex(
          working ? STATUS_COLORS.active : STATUS_COLORS.ready,
        )
        if (animation.workLight) {
          animation.workLight.intensity = working
            ? animation.workLightIntensity * 0.94
            : animation.workLightIntensity * 0.62
        }

        if (variant !== "full") continue
        const nextLabelSignature = departmentLabelSignature(
          nextDepartment,
          animation.logicalAgentCount,
        )
        if (animation.label && animation.labelSignature !== nextLabelSignature) {
          const selectableIndex = departmentSelectables.indexOf(animation.label)
          if (selectableIndex >= 0) departmentSelectables.splice(selectableIndex, 1)
          animation.group.remove(animation.label)
          disposeObjectResources(animation.label)
          animation.label = null
          animation.labelSignature = null
        }
        if (!animation.label) {
          const nextLabel = createDepartmentLabel(
            nextDepartment,
            animation.logicalAgentCount,
          )
          if (nextLabel) {
            nextLabel.position.copy(animation.labelPosition)
            animation.group.add(nextLabel)
            departmentSelectables.push(nextLabel)
            animation.label = nextLabel
            animation.labelSignature = nextLabelSignature
          }
        }
      }
    }
    liveSceneUpdateRef.current = updateLiveScene

    scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh) {
        if (mesh.userData.agentOfficeInteractionTarget) {
          mesh.castShadow = false
          mesh.receiveShadow = false
          return
        }
        mesh.castShadow = variant === "full" && mesh.position.y > 0.1
      }
    })

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let pointerDown = { x: 0, y: 0 }
    let dragging = false
    let lastPointer = { x: 0, y: 0 }

    const pointFromEvent = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    }

    const hitFromEvent = (event: PointerEvent) => {
      pointFromEvent(event)
      raycaster.setFromCamera(pointer, camera)
      return raycaster.intersectObjects(workerSelectables, false)[0]
        || raycaster.intersectObjects(departmentSelectables, false)[0]
    }

    const hitData = (hit: THREE.Intersection) => {
      if (
        hit.object.userData.agentOfficeCompactWorkers
        && hit.instanceId != null
      ) {
        return {
          workerId: hit.object.userData.workerIds?.[hit.instanceId] as string | undefined,
          departmentId: hit.object.userData.departmentIds?.[hit.instanceId] as string | undefined,
        }
      }
      let object: THREE.Object3D | null = hit.object
      while (object) {
        if (object.userData.workerId || object.userData.departmentId) return object.userData as {
          workerId?: string
          departmentId?: string
        }
        object = object.parent
      }
      return {}
    }

    const onPointerDown = (event: PointerEvent) => {
      if (variant === "thumbnail") return
      pointerDown = { x: event.clientX, y: event.clientY }
      lastPointer = pointerDown
      dragging = true
      renderer.domElement.setPointerCapture(event.pointerId)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (variant === "thumbnail") return
      if (dragging) {
        const dx = event.clientX - lastPointer.x
        const dy = event.clientY - lastPointer.y
        yaw -= dx * 0.006
        pitch = THREE.MathUtils.clamp(pitch + dy * 0.004, 0.28, 1.22)
        lastPointer = { x: event.clientX, y: event.clientY }
        updateCamera()
        return
      }
      renderer.domElement.style.cursor = hitFromEvent(event) ? "pointer" : "grab"
    }
    const onPointerUp = (event: PointerEvent) => {
      if (variant === "thumbnail") return
      const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y)
      dragging = false
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId)
      }
      if (moved > 7) return
      const hit = hitFromEvent(event)
      if (!hit) return
      const data = hitData(hit)
      if (data.workerId) selectWorkerRef.current?.(data.workerId)
      else if (data.departmentId) selectDepartmentRef.current?.(data.departmentId)
    }
    const onWheel = (event: WheelEvent) => {
      if (variant === "thumbnail") return
      event.preventDefault()
      distance = THREE.MathUtils.clamp(
        distance + event.deltaY * 0.018,
        edgeDistrict.framing.minDistance,
        maxCameraDistance,
      )
      updateCamera()
    }

    renderer.domElement.addEventListener("pointerdown", onPointerDown)
    renderer.domElement.addEventListener("pointermove", onPointerMove)
    renderer.domElement.addEventListener("pointerup", onPointerUp)
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false })

    const resize = () => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      invalidate()
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host)
    resize()

    let intersecting = true
    const intersectionObserver = typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver((entries) => {
          intersecting = entries.some((entry) => entry.isIntersecting)
          if (intersecting) invalidate()
        }, { threshold: 0.01 })
    intersectionObserver?.observe(host)
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") invalidate()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const animationStartedAt = window.performance.now()
    const projectedWorker = new THREE.Vector3()
    let frameCount = 0
    let readyReported = false

    /**
     * Pose a worker for its stance. The office used to walk everyone around
     * their department forever, so a floor with eight running agents looked
     * exactly like an empty one. Now a running agent sits at its own desk and
     * types, an agent waiting for review paces, and the rest wait standing.
     *
     * `motion` is false when the tab is hidden, the scene is paused or the user
     * asked for reduced motion — the pose still resolves, it just stops moving,
     * so a still frame is as readable as a live one.
     */
    const poseWorker = (animation: WorkerAnimation, elapsed: number, motion: boolean) => {
      const { group, head, leftArm, rightArm, leftLeg, rightLeg, screen } = animation

      if (animation.stance === "blocked") {
        if (!motion) {
          group.position.copy(animation.standPosition)
          group.rotation.y = Math.PI
          leftArm.rotation.x = 0
          rightArm.rotation.x = 0
          leftLeg.rotation.x = 0
          rightLeg.rotation.x = 0
          head.position.y = 1.82
          screen.material.emissiveIntensity = 0.42
          return
        }
        const walkProgress = (elapsed * animation.walkSpeed + animation.phase * 0.037) % 1
        const routePoint = animation.walkPath.getPointAt(walkProgress)
        const routeTangent = animation.walkPath.getTangentAt(walkProgress)
        const stridePhase = elapsed * 5.4 + animation.phase
        group.position.copy(routePoint)
        group.position.y = animation.baseY + Math.abs(Math.sin(stridePhase)) * 0.045
        group.rotation.y = Math.atan2(routeTangent.x, routeTangent.z)
        leftArm.rotation.x = Math.sin(stridePhase) * 0.72
        rightArm.rotation.x = -Math.sin(stridePhase) * 0.72
        leftLeg.rotation.x = -Math.sin(stridePhase) * 0.62
        rightLeg.rotation.x = Math.sin(stridePhase) * 0.62
        // Slow amber-ish throb: the desk is holding work that needs a human.
        screen.material.emissiveIntensity = 0.34 + (Math.sin(elapsed * 1.9 + animation.phase) + 1) * 0.11
        return
      }

      if (animation.stance === "working") {
        // Ramp from standing to seated so the start of a run is a visible act:
        // the agent takes its chair instead of popping into it.
        const settle = motion ? THREE.MathUtils.smoothstep(elapsed, 0.15, 1.35) : 1
        group.position.lerpVectors(animation.standPosition, animation.seatPosition, settle)
        group.rotation.y = Math.PI
        const typing = motion ? Math.sin(elapsed * 10.5 + animation.phase) : 0
        leftLeg.rotation.x = SEAT_LEG_PITCH * settle
        rightLeg.rotation.x = SEAT_LEG_PITCH * settle
        leftArm.rotation.x = SEAT_ARM_PITCH * settle + typing * 0.07
        rightArm.rotation.x = SEAT_ARM_PITCH * settle - typing * 0.07
        head.position.y = 1.82 + typing * 0.007
        screen.material.emissiveIntensity =
          0.36 + settle * (0.5 + (Math.sin(elapsed * 8.6 + animation.phase) + 1) * 0.19)
        return
      }

      if (animation.locomotion && motion) {
        const walkProgress = (elapsed * animation.walkSpeed * 0.58 + animation.phase * 0.037) % 1
        const routePoint = animation.walkPath.getPointAt(walkProgress)
        const routeTangent = animation.walkPath.getTangentAt(walkProgress)
        const stridePhase = elapsed * 4.1 + animation.phase
        group.position.copy(routePoint)
        group.position.y = animation.baseY + Math.abs(Math.sin(stridePhase)) * 0.035
        group.rotation.y = Math.atan2(routeTangent.x, routeTangent.z)
        leftArm.rotation.x = Math.sin(stridePhase) * 0.54
        rightArm.rotation.x = -Math.sin(stridePhase) * 0.54
        leftLeg.rotation.x = -Math.sin(stridePhase) * 0.5
        rightLeg.rotation.x = Math.sin(stridePhase) * 0.5
        head.position.y = 1.82
        screen.material.emissiveIntensity = 0.2
        return
      }

      const breath = motion ? Math.sin(elapsed * 1.05 + animation.phase) : 0
      group.position.copy(animation.standPosition)
      group.position.y = animation.baseY + breath * 0.012
      group.rotation.y = Math.PI + (motion ? Math.sin(elapsed * 0.24 + animation.phase) * 0.2 : 0)
      leftArm.rotation.x = breath * 0.05
      rightArm.rotation.x = -breath * 0.05
      leftLeg.rotation.x = 0
      rightLeg.rotation.x = 0
      head.position.y = 1.82
      screen.material.emissiveIntensity = 0.18
    }

    function animate(timestamp: number) {
      animationFrame = 0
      if (
        readyReported &&
        (
          document.visibilityState !== "visible"
          || !intersecting
          || (variant === "thumbnail" && pausedRef.current)
        )
      ) {
        return
      }
      const elapsed = Math.max(0, timestamp - animationStartedAt) / 1000
      const canAnimate =
        !pausedRef.current
        && !reducedMotion
        && intersecting
        && document.visibilityState === "visible"
      if (!canAnimate && readyReported && !needsRender) return

      for (const animation of workers) {
        animation.selectionRing.visible = selectedWorkerRef.current === animation.worker.id
        poseWorker(animation, elapsed, canAnimate)
        // Keep the ring on the carpet: sitting drops the whole rig below the
        // floor, which would bury the selection marker under the department.
        animation.selectionRing.position.y = 0.025 - animation.group.position.y
      }

      for (const department of departmentAnimations) {
        if (!department.working) continue
        // Same 1.35 s window as the workers sitting down, so the floor lights up
        // exactly as its agents take their desks.
        const ignition = canAnimate ? THREE.MathUtils.smoothstep(elapsed, 0.15, 1.35) : 1
        const beat = canAnimate ? (Math.sin(elapsed * 1.9 + department.phase) + 1) / 2 : 0.5
        department.boardMaterial.emissiveIntensity = 0.1 + ignition * (0.26 + beat * 0.24)
        if (department.workLight) {
          department.workLight.intensity =
            department.workLightIntensity * (0.62 + ignition * (0.32 + beat * 0.08))
        }
        const cycle = canAnimate ? (elapsed * 0.42 + department.phase * 0.31) % 1 : 0.35
        department.pulse.scale.setScalar(0.55 + cycle * 1.35)
        department.pulse.material.opacity = ignition * 0.4 * (1 - cycle) ** 1.6
      }

      if (canAnimate) {
        const { oceanGeometry, oceanPosition, oceanBase, beacon } = edgeDistrict
        for (let index = 0; index < oceanPosition.count; index += 1) {
          const x = oceanPosition.getX(index)
          const depth = oceanBase[index]
          const wave =
            Math.sin(elapsed * 0.72 + x * 0.11 + depth * 0.07) * 0.22 +
            Math.sin(elapsed * 0.43 - x * 0.05 + depth * 0.14) * 0.14 +
            Math.sin(elapsed * 1.1 + x * 0.18 + depth * 0.09) * 0.06
          oceanPosition.setZ(index, wave)
        }
        oceanPosition.needsUpdate = true
        if (frameCount % (variant === "full" ? 10 : 18) === 0) {
          oceanGeometry.computeVertexNormals()
        }
        edgeDistrict.animateVehicles(elapsed)
        const pulse = 1 + Math.sin(elapsed * 0.38) * 0.012
        beacon.scale.setScalar(pulse)
      }

      renderer.render(scene, camera)
      needsRender = false
      frameCount += 1
      renderer.domElement.dataset.frameCount = String(frameCount)
      renderer.domElement.dataset.officeDrawCalls = String(renderer.info.render.calls)
      renderer.domElement.dataset.officeTriangles = String(renderer.info.render.triangles)
      hostRef.current?.setAttribute("data-office-draw-calls", String(renderer.info.render.calls))
      hostRef.current?.setAttribute("data-office-triangles", String(renderer.info.render.triangles))
      if ((workers[0] || compactWorkerMarkers[0]) && frameCount % 6 === 0) {
        let visibleWorkerPoint: { x: number; y: number; score: number } | null = null
        let movingWorkerPoint: { x: number; y: number; score: number } | null = null
        for (const animation of workers) {
          animation.group.getWorldPosition(projectedWorker)
          projectedWorker.y += 1.02
          projectedWorker.project(camera)
          if (Math.abs(projectedWorker.x) > 0.88 || Math.abs(projectedWorker.y) > 0.82) continue
          const score = projectedWorker.x ** 2 + projectedWorker.y ** 2
          if (!visibleWorkerPoint || score < visibleWorkerPoint.score) {
            visibleWorkerPoint = { x: projectedWorker.x, y: projectedWorker.y, score }
          }
          if (
            animation.locomotion &&
            (!movingWorkerPoint || score < movingWorkerPoint.score)
          ) {
            movingWorkerPoint = { x: projectedWorker.x, y: projectedWorker.y, score }
          }
        }
        if (visibleWorkerPoint) {
          renderer.domElement.dataset.firstWorkerX = String(
            Math.round(((visibleWorkerPoint.x + 1) / 2) * renderer.domElement.clientWidth),
          )
          renderer.domElement.dataset.firstWorkerY = String(
            Math.round(((-visibleWorkerPoint.y + 1) / 2) * renderer.domElement.clientHeight),
          )
        }
        if (movingWorkerPoint) {
          renderer.domElement.dataset.movingWorkerX = String(
            Math.round(((movingWorkerPoint.x + 1) / 2) * renderer.domElement.clientWidth),
          )
          renderer.domElement.dataset.movingWorkerY = String(
            Math.round(((-movingWorkerPoint.y + 1) / 2) * renderer.domElement.clientHeight),
          )
        }
        let visibleCompactWorker: {
          marker: CompactWorkerMarker
          x: number
          y: number
          score: number
        } | null = null
        for (const marker of compactWorkerMarkers) {
          projectedWorker.set(...marker.position)
          projectedWorker.project(camera)
          if (Math.abs(projectedWorker.x) > 0.55 || Math.abs(projectedWorker.y) > 0.58) continue
          const score = projectedWorker.x ** 2 + projectedWorker.y ** 2
          if (!visibleCompactWorker || score < visibleCompactWorker.score) {
            visibleCompactWorker = {
              marker,
              x: projectedWorker.x,
              y: projectedWorker.y,
              score,
            }
          }
        }
        if (visibleCompactWorker) {
          renderer.domElement.dataset.compactWorkerX = String(
            Math.round(((visibleCompactWorker.x + 1) / 2) * renderer.domElement.clientWidth),
          )
          renderer.domElement.dataset.compactWorkerY = String(
            Math.round(((-visibleCompactWorker.y + 1) / 2) * renderer.domElement.clientHeight),
          )
          renderer.domElement.dataset.compactWorkerId = visibleCompactWorker.marker.worker.id
          renderer.domElement.dataset.compactWorkerName = visibleCompactWorker.marker.worker.name
        }
        renderer.domElement.dataset.workerCount = String(renderedInteractiveWorkerCount)
      }
      if (!readyReported && frameCount >= 2) {
        readyReported = true
        hostRef.current?.setAttribute("data-office-ready", "true")
        onReadyRef.current?.()
      }
      if (canAnimate || !readyReported) scheduleFrame()
    }
    scheduleFrame()

    return () => {
      window.cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      intersectionObserver?.disconnect()
      document.removeEventListener("visibilitychange", onVisibilityChange)
      renderer.domElement.removeEventListener("pointerdown", onPointerDown)
      renderer.domElement.removeEventListener("pointermove", onPointerMove)
      renderer.domElement.removeEventListener("pointerup", onPointerUp)
      renderer.domElement.removeEventListener("wheel", onWheel)
      cameraControlsRef.current = null
      invalidateSceneRef.current = null
      if (liveSceneUpdateRef.current === updateLiveScene) {
        liveSceneUpdateRef.current = null
      }
      disposeScene(scene)
      renderer.dispose()
      renderer.domElement.remove()
      delete host.dataset.officeReady
      delete host.dataset.cityBuildingCount
      delete host.dataset.officeDepartmentCount
      delete host.dataset.officeRenderedDepartmentCount
      delete host.dataset.officeLogicalAgentCount
      delete host.dataset.officeRenderedLogicalAgentCount
      delete host.dataset.officeInteractiveWorkerCount
      delete host.dataset.officeRenderedInteractiveWorkerCount
      delete host.dataset.officeStandbyAgentCount
      delete host.dataset.officeRenderedStandbyAgentCount
      delete host.dataset.officeStandbyRenderedCount
      delete host.dataset.officeStandbyOverflowCount
      delete host.dataset.officeCeoCentral
      delete host.dataset.officeDrawCalls
      delete host.dataset.officeTriangles
    }
  }, [timeOfDay, timePhase, topologySignature, variant])

  return (
    <div
      ref={hostRef}
      className={cn(
        "relative h-full min-h-0 w-full overflow-hidden",
        timeOfDay === "night" ? "bg-[#173047]" : "bg-[#b9d8e2]",
        className,
      )}
      data-testid={variant === "thumbnail" ? "agent-office-thumbnail" : "agent-office-scene"}
      data-office-ready="false"
      data-office-paused={paused ? "true" : "false"}
      data-rooftop-office="true"
      data-office-department-count={officePopulation.departmentCount}
      data-office-logical-agent-count={officePopulation.logicalAgentCount}
      data-office-interactive-worker-count={officePopulation.interactiveWorkerCount}
      data-office-standby-agent-count={officePopulation.standbyAgentCount}
      data-office-time={timeOfDay || "auto"}
      data-office-phase={timePhase || "auto"}
    >
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950 px-6 text-center text-xs text-zinc-300">
          La vista 3D no está disponible en este navegador.
        </div>
      ) : null}
    </div>
  )
}
