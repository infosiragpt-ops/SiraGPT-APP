"use client"

import * as React from "react"
import * as THREE from "three"

import {
  officeWorkerStance,
  type AgentOfficeActivity,
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

type AgentOfficeSceneProps = {
  model: AgentOfficeModel
  variant?: "full" | "thumbnail"
  paused?: boolean
  timeOfDay?: OfficeTimeOfDay
  timePhase?: OfficeTimePhase
  selectedWorkerId?: string | null
  resetCameraKey?: number
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
  selectionRing: THREE.Mesh
  walkPath: THREE.CatmullRomCurve3
  walkSpeed: number
  phase: number
  baseY: number
  /** Where the agent stands when it has nothing running. */
  standPosition: THREE.Vector3
  /** The chair in front of its own desk — where a running agent types. */
  seatPosition: THREE.Vector3
}

type DepartmentAnimation = {
  working: boolean
  boardMaterial: THREE.MeshStandardMaterial
  workLight: THREE.PointLight | null
  workLightIntensity: number
  pulse: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  phase: number
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
    sunIntensity: 1.95,
    sunPosition: [22, 13, 10],
    hemisphereSky: 0xffe6cd,
    hemisphereGround: 0x5b5a63,
    hemisphereIntensity: 1.45,
    fillColor: 0xc9bcff,
    fillIntensity: 1.05,
    exposure: 1.07,
    background: 0xbcd6e6,
    fog: 0xd6cfc6,
    horizon: 0xf2cfa8,
    floor: 0xcbbfa4,
  },
  day: {
    sunColor: 0xfff4dd,
    sunIntensity: 2.45,
    sunPosition: [-18, 28, 14],
    hemisphereSky: 0xffffff,
    hemisphereGround: 0x53606a,
    hemisphereIntensity: 1.7,
    fillColor: 0xc9e7ff,
    fillIntensity: 1.2,
    exposure: 1.05,
    background: 0x9fd2ea,
    fog: 0xaed9e8,
    horizon: 0xb9e2ef,
    floor: 0xcfbd99,
  },
  dusk: {
    sunColor: 0xffab6d,
    sunIntensity: 2.1,
    sunPosition: [-24, 11, 8],
    hemisphereSky: 0xffd5ae,
    hemisphereGround: 0x4a4750,
    hemisphereIntensity: 1.38,
    fillColor: 0x9db4f0,
    fillIntensity: 1.02,
    exposure: 1.09,
    background: 0xdfae86,
    fog: 0xd9b899,
    horizon: 0xf0b183,
    floor: 0xc8ab8a,
  },
  night: {
    sunColor: 0xa9c9ff,
    sunIntensity: 1.05,
    sunPosition: [-18, 28, 14],
    hemisphereSky: 0x7ba5c5,
    hemisphereGround: 0x07111b,
    hemisphereIntensity: 1.3,
    fillColor: 0x7fa5d6,
    fillIntensity: 0.92,
    exposure: 1.12,
    background: 0x0b2136,
    fog: 0x0b2136,
    horizon: 0x0b2136,
    floor: 0x7f898e,
  },
}

type CoastalArchitecture = {
  oceanGeometry: THREE.PlaneGeometry
  oceanPosition: THREE.BufferAttribute
  oceanBase: Float32Array
  beacon: THREE.Mesh
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

function material(color: number, roughness = 0.72, metalness = 0.03) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness })
}

function tagObject(object: THREE.Object3D, data: Record<string, string>) {
  object.traverse((child) => Object.assign(child.userData, data))
}

function addDesk(sceneGroup: THREE.Group, x: number, z: number, active: boolean) {
  const desk = new THREE.Group()
  desk.position.set(x, 0, z)

  const desktop = new THREE.Mesh(
    new THREE.BoxGeometry(1.75, 0.14, 0.78),
    material(0x15314b, 0.58, 0.08),
  )
  desktop.position.y = 0.82
  desk.add(desktop)

  const legMaterial = material(0x1f2937, 0.8)
  for (const legX of [-0.68, 0.68]) {
    for (const legZ of [-0.25, 0.25]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.75, 0.08), legMaterial)
      leg.position.set(legX, 0.4, legZ)
      desk.add(leg)
    }
  }

  const monitorBack = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.52, 0.08),
    material(0x172033, 0.45, 0.15),
  )
  monitorBack.position.set(0, 1.28, -0.22)
  monitorBack.rotation.x = -0.04
  desk.add(monitorBack)

  const screenMaterial = new THREE.MeshStandardMaterial({
    color: active ? 0x9bdcff : 0x69809a,
    emissive: active ? 0x164e63 : 0x111827,
    emissiveIntensity: active ? 1.1 : 0.2,
    roughness: 0.38,
  })
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.68, 0.4), screenMaterial)
  screen.position.set(0, 1.28, -0.175)
  desk.add(screen)

  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.35, 0.07), legMaterial)
  stand.position.set(0, 1.03, -0.18)
  desk.add(stand)

  sceneGroup.add(desk)
  return screen
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
  canvas.height = 144
  const context = canvas.getContext("2d")
  if (!context) return null

  context.fillStyle = "rgba(255, 255, 255, 0.96)"
  context.beginPath()
  context.roundRect(10, 10, 620, 124, 24)
  context.fill()
  context.strokeStyle = "rgba(15, 23, 42, 0.14)"
  context.lineWidth = 3
  context.stroke()

  context.fillStyle = "#111827"
  context.font = "600 38px Inter, system-ui, sans-serif"
  context.fillText(worker.name.slice(0, 27), 38, 62)
  context.fillStyle = worker.active ? "#0284c7" : "#64748b"
  context.font = "500 28px Inter, system-ui, sans-serif"
  context.fillText(worker.statusLabel.slice(0, 34), 38, 105)

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
  sprite.scale.set(2.65, 0.6, 1)
  sprite.position.set(0, 2.26, 0)
  sprite.renderOrder = 20
  return sprite
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

  const bodyMaterial = material(ACTIVITY_COLORS[worker.activity], 0.68)
  const skinTones = [0xf0c59b, 0xd9a06f, 0xb97745, 0x7d4d2d]
  const skinMaterial = material(skinTones[workerIndex % skinTones.length], 0.76)
  const trousersMaterial = material(workerIndex % 2 === 0 ? 0x26384a : 0x35313f, 0.8)
  const shoeMaterial = material(0x17191e, 0.88)
  const hairMaterial = material(workerIndex % 3 === 0 ? 0x171717 : 0x4b342b, 0.9)

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.5, 6, 12), bodyMaterial)
  body.position.y = 1.23
  group.add(body)

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 14, 10), skinMaterial)
  head.position.y = 1.82
  group.add(head)

  const eyeMaterial = material(0x111827, 0.82)
  for (const eyeX of [-0.075, 0.075]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 6), eyeMaterial)
    eye.position.set(eyeX, 1.85, 0.215)
    group.add(eye)
  }

  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.235, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.58),
    hairMaterial,
  )
  hair.position.y = 1.88
  group.add(hair)

  const statusHalo = new THREE.Mesh(
    new THREE.RingGeometry(0.27, 0.33, 20),
    new THREE.MeshBasicMaterial({
      color: STATUS_COLORS[worker.statusTone],
      transparent: true,
      opacity: worker.active ? 0.95 : 0.55,
      side: THREE.DoubleSide,
    }),
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
  group.add(interactionTarget)

  if (showLabel) {
    const label = createWorkerLabel(worker)
    if (label) group.add(label)
  }

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
    selectionRing,
    walkPath: route,
    walkSpeed: worker.statusTone === "attention" ? 0.038 : 0.03,
    phase: workerIndex * 1.37,
    baseY: group.position.y,
    standPosition: new THREE.Vector3(x, 0, z + 1.15),
    // The chair addChair() puts in front of this desk. A running agent walks
    // the last step to it and sits, so the desk it occupies is the one whose
    // screen is lit.
    seatPosition: new THREE.Vector3(x, SEAT_HIP_DROP, z + SEAT_FORWARD_OFFSET),
  }
}

function addPlant(
  parent: THREE.Group,
  x: number,
  z: number,
  timeOfDay: OfficeTimeOfDay,
) {
  const planter = new THREE.Mesh(
    new THREE.BoxGeometry(0.72, 0.48, 0.72),
    material(timeOfDay === "day" ? 0xe3e7e4 : 0x667179, 0.68, 0.08),
  )
  planter.position.set(x, 0.24, z)
  parent.add(planter)

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.08, 0.72, 8),
    material(0x6f4e37, 0.86),
  )
  trunk.position.set(x, 0.78, z)
  parent.add(trunk)

  const foliage = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.44, 1),
    new THREE.MeshStandardMaterial({
      color: timeOfDay === "day" ? 0x2f7d5c : 0x275a4b,
      roughness: 0.8,
      emissive: timeOfDay === "night" ? 0x0f3329 : 0x000000,
      emissiveIntensity: timeOfDay === "night" ? 0.18 : 0,
    }),
  )
  foliage.position.set(x, 1.28, z)
  foliage.scale.set(1, 1.3, 1)
  parent.add(foliage)
}

function addGlassPanel(
  parent: THREE.Group,
  width: number,
  height: number,
  timeOfDay: OfficeTimeOfDay,
) {
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshPhysicalMaterial({
      color: timeOfDay === "day" ? 0xa9d5e5 : 0x31506a,
      roughness: 0.12,
      metalness: 0.18,
      transmission: timeOfDay === "day" ? 0.5 : 0.22,
      transparent: true,
      opacity: timeOfDay === "day" ? 0.34 : 0.54,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  parent.add(panel)
  return panel
}

function addCoastalArchitecture({
  scene,
  totalWidth,
  totalDepth,
  timeOfDay,
  light,
  variant,
}: {
  scene: THREE.Scene
  totalWidth: number
  totalDepth: number
  timeOfDay: OfficeTimeOfDay
  light: PhaseLighting
  variant: "full" | "thumbnail"
}): CoastalArchitecture {
  const night = timeOfDay === "night"
  scene.background = new THREE.Color(light.background)
  scene.fog = new THREE.Fog(light.fog, 58, 142)

  const horizon = new THREE.Mesh(
    new THREE.PlaneGeometry(190, 72),
    new THREE.MeshBasicMaterial({
      color: light.horizon,
      fog: false,
    }),
  )
  horizon.position.set(0, 20, -78)
  horizon.renderOrder = -10
  scene.add(horizon)

  const oceanGeometry = new THREE.PlaneGeometry(
    190,
    104,
    variant === "full" ? 52 : 26,
    variant === "full" ? 28 : 14,
  )
  const oceanPosition = oceanGeometry.attributes.position as THREE.BufferAttribute
  const oceanBase = new Float32Array(oceanPosition.count)
  for (let index = 0; index < oceanPosition.count; index += 1) {
    oceanBase[index] = oceanPosition.getY(index)
  }
  const ocean = new THREE.Mesh(
    oceanGeometry,
    new THREE.MeshPhysicalMaterial({
      color: night ? 0x125675 : 0x2388aa,
      roughness: night ? 0.36 : 0.24,
      metalness: 0.22,
      clearcoat: 0.62,
      clearcoatRoughness: 0.22,
      emissive: night ? 0x062235 : 0x082b36,
      emissiveIntensity: night ? 0.42 : 0.08,
    }),
  )
  ocean.rotation.x = -Math.PI / 2
  ocean.position.set(0, -1.45, -totalDepth / 2 - 49)
  ocean.receiveShadow = false
  scene.add(ocean)

  const building = new THREE.Group()
  const tower = new THREE.Mesh(
    new THREE.BoxGeometry(totalWidth + 8, 8.5, totalDepth + 8),
    new THREE.MeshStandardMaterial({
      color: night ? 0x162838 : 0x5f8599,
      roughness: 0.24,
      metalness: 0.52,
      emissive: night ? 0x081522 : 0x000000,
      emissiveIntensity: night ? 0.38 : 0,
    }),
  )
  tower.position.y = -4.48
  building.add(tower)

  const facadeMaterial = new THREE.MeshStandardMaterial({
    color: night ? 0xffd58a : 0xa9e3f6,
    emissive: night ? 0xffb84d : 0x2f7f9a,
    emissiveIntensity: night ? 1.1 : 0.18,
    roughness: 0.28,
    metalness: 0.22,
  })
  const facadeWidth = totalWidth + 6.8
  const frontZ = totalDepth / 2 + 4.03
  const facadeColumns = Math.max(6, Math.floor(facadeWidth / 2.15))
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < facadeColumns; column += 1) {
      const window = new THREE.Mesh(
        new THREE.PlaneGeometry(1.14, 0.72),
        facadeMaterial,
      )
      window.position.set(
        -facadeWidth / 2 + 1.05 + column * (facadeWidth - 2.1) / Math.max(1, facadeColumns - 1),
        -1.28 - row * 1.28,
        frontZ,
      )
      building.add(window)
    }
  }

  const terrace = new THREE.Mesh(
    new THREE.BoxGeometry(totalWidth + 5, 0.22, 4.5),
    material(night ? 0x77838a : 0xdce2e1, 0.82, 0.08),
  )
  terrace.position.set(0, -0.02, totalDepth / 2 + 2.35)
  terrace.receiveShadow = variant === "full"
  building.add(terrace)

  const glassHeight = 3.85
  const panelWidth = 2.8
  const backWidth = totalWidth + 4
  const backPanels = Math.ceil(backWidth / panelWidth)
  const mullionMaterial = material(night ? 0x2e3b45 : 0x607783, 0.38, 0.72)
  for (let index = 0; index < backPanels; index += 1) {
    const width = backWidth / backPanels - 0.06
    const panel = addGlassPanel(building, width, glassHeight, timeOfDay)
    panel.position.set(
      -backWidth / 2 + width / 2 + index * (backWidth / backPanels),
      glassHeight / 2,
      -totalDepth / 2 - 1.08,
    )
  }
  for (let index = 0; index <= backPanels; index += 1) {
    const mullion = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, glassHeight + 0.1, 0.08),
      mullionMaterial,
    )
    mullion.position.set(
      -backWidth / 2 + index * (backWidth / backPanels),
      glassHeight / 2,
      -totalDepth / 2 - 1.04,
    )
    building.add(mullion)
  }
  for (const y of [0.08, 1.34, 2.62, 3.88]) {
    const crossbar = new THREE.Mesh(
      new THREE.BoxGeometry(backWidth + 0.08, 0.065, 0.09),
      mullionMaterial,
    )
    crossbar.position.set(0, y, -totalDepth / 2 - 1.02)
    building.add(crossbar)
  }

  const sideDepth = totalDepth + 5.2
  const sidePanels = Math.max(2, Math.ceil(sideDepth / panelWidth))
  for (const side of [-1, 1]) {
    for (let index = 0; index < sidePanels; index += 1) {
      const width = sideDepth / sidePanels - 0.06
      const panel = addGlassPanel(building, width, glassHeight, timeOfDay)
      panel.rotation.y = Math.PI / 2
      panel.position.set(
        side * (totalWidth / 2 + 1.08),
        glassHeight / 2,
        -sideDepth / 2 + width / 2 + index * (sideDepth / sidePanels),
      )
    }
    for (const y of [0.08, 1.34, 2.62, 3.88]) {
      const crossbar = new THREE.Mesh(
        new THREE.BoxGeometry(0.09, 0.065, sideDepth + 0.08),
        mullionMaterial,
      )
      crossbar.position.set(side * (totalWidth / 2 + 1.04), y, 0)
      building.add(crossbar)
    }
  }

  const railZ = totalDepth / 2 + 4.5
  const railPanels = Math.max(3, Math.ceil((totalWidth + 4) / 3.2))
  for (let index = 0; index < railPanels; index += 1) {
    const width = (totalWidth + 4) / railPanels - 0.08
    const rail = addGlassPanel(building, width, 1.05, timeOfDay)
    rail.position.set(
      -(totalWidth + 4) / 2 + width / 2 + index * ((totalWidth + 4) / railPanels),
      0.62,
      railZ,
    )
  }

  for (const x of [-totalWidth / 2 - 0.3, totalWidth / 2 + 0.3]) {
    addPlant(building, x, totalDepth / 2 + 2.8, timeOfDay)
  }
  addPlant(building, -totalWidth / 2 - 0.3, -totalDepth / 2 + 0.2, timeOfDay)
  addPlant(building, totalWidth / 2 + 0.3, -totalDepth / 2 + 0.2, timeOfDay)

  const canopy = new THREE.Mesh(
    new THREE.BoxGeometry(Math.min(totalWidth * 0.44, 15), 0.18, 3.2),
    material(night ? 0x263743 : 0xe8eff1, 0.34, 0.42),
  )
  canopy.position.set(0, 4.08, -totalDepth / 2 + 0.55)
  building.add(canopy)

  const loungeMaterial = material(night ? 0x243b4a : 0xf4f6f5, 0.78)
  for (const x of [-2.2, 2.2]) {
    const bench = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.45, 0.82), loungeMaterial)
    bench.position.set(x, 0.28, totalDepth / 2 + 2.45)
    building.add(bench)
  }

  scene.add(building)

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(night ? 1.05 : 1.42, 24, 16),
    new THREE.MeshBasicMaterial({
      color: night ? 0xe8f1ff : 0xfff1b8,
      fog: false,
    }),
  )
  beacon.position.set(night ? 20 : -24, night ? 17 : 22, -56)
  scene.add(beacon)

  if (night) {
    const starCount = variant === "full" ? 180 : 80
    const starPositions = new Float32Array(starCount * 3)
    for (let index = 0; index < starCount; index += 1) {
      starPositions[index * 3] = (Math.random() - 0.5) * 120
      starPositions[index * 3 + 1] = 6 + Math.random() * 36
      starPositions[index * 3 + 2] = -48 - Math.random() * 45
    }
    const starsGeometry = new THREE.BufferGeometry()
    starsGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3))
    scene.add(new THREE.Points(
      starsGeometry,
      new THREE.PointsMaterial({
        color: 0xd7e7ff,
        size: 0.18,
        transparent: true,
        opacity: 0.82,
        fog: false,
      }),
    ))

    const terraceLight = new THREE.PointLight(0xffcf8a, 28, Math.max(totalWidth, totalDepth) * 1.45, 1.7)
    terraceLight.position.set(0, 5.5, totalDepth / 2 + 0.8)
    scene.add(terraceLight)
  }

  return { oceanGeometry, oceanPosition, oceanBase, beacon }
}

function disposeScene(scene: THREE.Scene) {
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const current of materials) current.dispose()
  })
}

function officeSceneModelSignature(model: AgentOfficeModel): string {
  return JSON.stringify(
    model.departments.map((department) => ({
      id: department.id,
      workers: department.workers.map((worker) => ({
        id: worker.id,
        name: worker.name,
        departmentId: worker.departmentId,
        statusLabel: worker.statusLabel,
        statusTone: worker.statusTone,
        active: worker.active,
        activity: worker.activity,
      })),
    })),
  )
}

export function AgentOfficeScene({
  model,
  variant = "full",
  paused = false,
  timeOfDay,
  timePhase,
  selectedWorkerId = null,
  resetCameraKey = 0,
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
  const resetCameraRef = React.useRef<(() => void) | null>(null)
  const modelRef = React.useRef(model)
  const [failed, setFailed] = React.useState(false)
  const modelSignature = React.useMemo(() => officeSceneModelSignature(model), [model])

  modelRef.current = model

  React.useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  React.useEffect(() => {
    selectedWorkerRef.current = selectedWorkerId
  }, [selectedWorkerId])

  React.useEffect(() => {
    selectWorkerRef.current = onSelectWorker
    selectDepartmentRef.current = onSelectDepartment
    onReadyRef.current = onReady
  }, [onReady, onSelectDepartment, onSelectWorker])

  React.useEffect(() => {
    if (resetCameraKey > 0) resetCameraRef.current?.()
  }, [resetCameraKey])

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const resolvedPhase = timePhase || (timeOfDay ? (timeOfDay as OfficeTimePhase) : officeTimePhase())
    // The phase always refines the day/night structure, so deriving one from
    // the other can never light a starfield with a sunset.
    const resolvedTimeOfDay: OfficeTimeOfDay = resolvedPhase === "night" ? "night" : "day"
    const night = resolvedTimeOfDay === "night"
    const light = PHASE_LIGHTING[resolvedPhase]

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: variant === "full",
        alpha: false,
        powerPreference: "high-performance",
        preserveDrawingBuffer: true,
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, variant === "thumbnail" ? 1 : 1.5))
    renderer.shadowMap.enabled = variant === "full"
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.domElement.className = "block h-full w-full touch-none"
    renderer.domElement.setAttribute("aria-label", "Oficina 3D de agentes y departamentos")
    renderer.domElement.dataset.officeCanvas = variant
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 160)
    const target = new THREE.Vector3(0, 0, 0)
    let yaw = -0.72
    let pitch = 0.72
    let distance = 34

    const sceneModel = modelRef.current
    const populatedDepartments = sceneModel.departments.filter((department) => department.workers.length > 0)
    const officeDepartments =
      populatedDepartments.length > 0 && sceneModel.departments.length > 1
        ? populatedDepartments
        : sceneModel.departments
    const departments = officeDepartments.slice(0, variant === "thumbnail" ? 6 : 10)
    const columns =
      variant === "thumbnail"
        ? Math.min(3, Math.max(1, departments.length))
        : Math.min(3, Math.max(1, Math.ceil(Math.sqrt(departments.length * 1.2))))
    const rows = Math.max(1, Math.ceil(departments.length / columns))
    const zoneWidth = variant === "thumbnail" ? 7.2 : 10.4
    const zoneDepth = variant === "thumbnail" ? 5.4 : 7.6
    const gapX = variant === "thumbnail" ? 1.2 : 1.7
    const gapZ = variant === "thumbnail" ? 1.1 : 1.7
    const totalWidth = columns * zoneWidth + Math.max(0, columns - 1) * gapX
    const totalDepth = rows * zoneDepth + Math.max(0, rows - 1) * gapZ

    const updateCamera = () => {
      const horizontal = Math.cos(pitch) * distance
      camera.position.set(
        target.x + Math.sin(yaw) * horizontal,
        target.y + Math.sin(pitch) * distance,
        target.z + Math.cos(yaw) * horizontal,
      )
      camera.lookAt(target)
    }

    const resetCamera = () => {
      yaw = -0.72
      pitch = variant === "thumbnail" ? 0.66 : 0.5
      const baseDistance = Math.max(
        variant === "thumbnail" ? 18 : 22,
        Math.max(totalWidth * 0.82, totalDepth * 1.14),
      )
      const aspect = Math.max(0.35, host.clientWidth / Math.max(1, host.clientHeight))
      distance = Math.min(72, baseDistance * Math.max(1, 0.9 / aspect))
      target.set(0, 0.72, -totalDepth * 0.12)
      updateCamera()
    }
    resetCameraRef.current = resetCamera
    resetCamera()

    const coastalArchitecture = addCoastalArchitecture({
      scene,
      totalWidth,
      totalDepth,
      timeOfDay: resolvedTimeOfDay,
      light,
      variant,
    })

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
      sun.shadow.mapSize.set(2048, 2048)
      sun.shadow.camera.left = -30
      sun.shadow.camera.right = 30
      sun.shadow.camera.top = 30
      sun.shadow.camera.bottom = -30
    }
    scene.add(sun)
    const fill = new THREE.DirectionalLight(light.fillColor, light.fillIntensity)
    fill.position.set(18, 12, -16)
    scene.add(fill)

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(totalWidth + 10, totalDepth + 10),
      material(light.floor, 0.92),
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

    const workers: WorkerAnimation[] = []
    const departmentAnimations: DepartmentAnimation[] = []
    const selectables: THREE.Object3D[] = []

    departments.forEach((department, departmentIndex) => {
      const column = departmentIndex % columns
      const row = Math.floor(departmentIndex / columns)
      const zoneX = column * (zoneWidth + gapX) - totalWidth / 2 + zoneWidth / 2
      const zoneZ = row * (zoneDepth + gapZ) - totalDepth / 2 + zoneDepth / 2
      const departmentGroup = new THREE.Group()
      departmentGroup.position.set(zoneX, 0, zoneZ)

      const working = department.activeCount > 0
      let workLight: THREE.PointLight | null = null
      const workLightIntensity = working ? 8.5 : 5.5
      if (night) {
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
        new THREE.BoxGeometry(zoneWidth, 0.12, zoneDepth),
        material(departmentIndex === 0 ? 0x414b54 : 0x4f5961, 0.96),
      )
      carpet.position.y = -0.01
      carpet.receiveShadow = variant === "full"
      tagObject(carpet, { departmentId: department.id })
      departmentGroup.add(carpet)
      selectables.push(carpet)

      const stripeColor = ACTIVITY_COLORS[department.workers[0]?.activity || (department.id === "ceo-office" ? "coordination" : "software")]
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(zoneWidth - 0.45, 0.025, 0.12),
        new THREE.MeshBasicMaterial({ color: stripeColor }),
      )
      stripe.position.set(0, 0.07, -zoneDepth / 2 + 0.23)
      departmentGroup.add(stripe)

      const visibleWorkers = department.workers.slice(0, variant === "thumbnail" ? 5 : 12)
      const deskCount = Math.max(variant === "thumbnail" ? 2 : 3, visibleWorkers.length)
      const deskColumns = Math.min(variant === "thumbnail" ? 3 : 4, deskCount)
      const deskRows = Math.ceil(deskCount / deskColumns)
      const spacingX = Math.min(2.1, (zoneWidth - 1.5) / Math.max(1, deskColumns))
      const spacingZ = Math.min(2.2, (zoneDepth - 1.6) / Math.max(1, deskRows))

      for (let deskIndex = 0; deskIndex < deskCount; deskIndex += 1) {
        const deskColumn = deskIndex % deskColumns
        const deskRow = Math.floor(deskIndex / deskColumns)
        const deskX = (deskColumn - (deskColumns - 1) / 2) * spacingX
        const deskZ = (deskRow - (deskRows - 1) / 2) * spacingZ - 0.15
        const worker = visibleWorkers[deskIndex]
        const screen = addDesk(departmentGroup, deskX, deskZ, Boolean(worker?.active))
        addChair(departmentGroup, deskX, deskZ + 0.88)
        if (worker) {
          const animation = addWorker({
            sceneGroup: departmentGroup,
            worker,
            x: deskX,
            z: deskZ,
            workerIndex: workers.length,
            zoneWidth,
            zoneDepth,
            showLabel: variant === "full",
          })
          animation.screen = screen
          workers.push(animation)
          selectables.push(animation.group)
        }
      }

      const board = new THREE.Mesh(
        new THREE.BoxGeometry(Math.min(3.6, zoneWidth - 1.1), 1.7, 0.14),
        material(0x203750, 0.48, 0.12),
      )
      board.position.set(0, 1.18, -zoneDepth / 2 + 0.32)
      tagObject(board, { departmentId: department.id })
      departmentGroup.add(board)
      selectables.push(board)

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
      selectables.push(boardLight)

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
        working,
        boardMaterial,
        workLight,
        workLightIntensity,
        pulse,
        phase: departmentIndex * 0.83,
      })

      scene.add(departmentGroup)
    })

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
      return raycaster.intersectObjects(selectables, true).find((hit) => {
        let object: THREE.Object3D | null = hit.object
        while (object) {
          if (object.userData.workerId || object.userData.departmentId) return true
          object = object.parent
        }
        return false
      })
    }

    const hitData = (object: THREE.Object3D) => {
      let current: THREE.Object3D | null = object
      while (current) {
        if (current.userData.workerId || current.userData.departmentId) return current.userData as {
          workerId?: string
          departmentId?: string
        }
        current = current.parent
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
      const data = hitData(hit.object)
      if (data.workerId) selectWorkerRef.current?.(data.workerId)
      else if (data.departmentId) selectDepartmentRef.current?.(data.departmentId)
    }
    const onWheel = (event: WheelEvent) => {
      if (variant === "thumbnail") return
      event.preventDefault()
      distance = THREE.MathUtils.clamp(distance + event.deltaY * 0.018, 12, 72)
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
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(host)
    resize()

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const animationStartedAt = window.performance.now()
    const projectedWorker = new THREE.Vector3()
    let animationFrame = 0
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
        if (!motion) return
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

    const animate = (timestamp: number) => {
      animationFrame = window.requestAnimationFrame(animate)
      const elapsed = Math.max(0, timestamp - animationStartedAt) / 1000
      const canAnimate = !pausedRef.current && !reducedMotion && document.visibilityState === "visible"

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
        const { oceanGeometry, oceanPosition, oceanBase, beacon } = coastalArchitecture
        for (let index = 0; index < oceanPosition.count; index += 1) {
          const x = oceanPosition.getX(index)
          const depth = oceanBase[index]
          const wave =
            Math.sin(elapsed * 0.72 + x * 0.11 + depth * 0.07) * 0.12 +
            Math.sin(elapsed * 0.43 - x * 0.05 + depth * 0.14) * 0.07
          oceanPosition.setZ(index, wave)
        }
        oceanPosition.needsUpdate = true
        if (frameCount % 4 === 0) oceanGeometry.computeVertexNormals()
        const pulse = 1 + Math.sin(elapsed * 0.38) * 0.012
        beacon.scale.setScalar(pulse)
      }

      renderer.render(scene, camera)
      frameCount += 1
      renderer.domElement.dataset.frameCount = String(frameCount)
      if (workers[0] && frameCount % 6 === 0) {
        let visibleWorkerPoint: { x: number; y: number; score: number } | null = null
        for (const animation of workers) {
          animation.group.getWorldPosition(projectedWorker)
          projectedWorker.y += 1.02
          projectedWorker.project(camera)
          if (Math.abs(projectedWorker.x) > 0.88 || Math.abs(projectedWorker.y) > 0.82) continue
          const score = projectedWorker.x ** 2 + projectedWorker.y ** 2
          if (!visibleWorkerPoint || score < visibleWorkerPoint.score) {
            visibleWorkerPoint = { x: projectedWorker.x, y: projectedWorker.y, score }
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
        renderer.domElement.dataset.workerCount = String(workers.length)
      }
      if (!readyReported && frameCount >= 2) {
        readyReported = true
        host.dataset.officeReady = "true"
        onReadyRef.current?.()
      }
    }
    animationFrame = window.requestAnimationFrame(animate)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      renderer.domElement.removeEventListener("pointerdown", onPointerDown)
      renderer.domElement.removeEventListener("pointermove", onPointerMove)
      renderer.domElement.removeEventListener("pointerup", onPointerUp)
      renderer.domElement.removeEventListener("wheel", onWheel)
      resetCameraRef.current = null
      disposeScene(scene)
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
      delete host.dataset.officeReady
    }
  }, [modelSignature, timeOfDay, timePhase, variant])

  return (
    <div
      ref={hostRef}
      className={cn(
        "relative h-full min-h-0 w-full overflow-hidden",
        timeOfDay === "night" ? "bg-[#0b2136]" : "bg-[#aed9e8]",
        className,
      )}
      data-testid={variant === "thumbnail" ? "agent-office-thumbnail" : "agent-office-scene"}
      data-office-ready="false"
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
