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

import { addEdgeDistrict } from "./agent-office-city"

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
  locomotion: boolean
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

function material(color: number, roughness = 0.72, metalness = 0.03) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness })
}

function tagObject(object: THREE.Object3D, data: Record<string, string>) {
  object.traverse((child) => Object.assign(child.userData, data))
}

function addDesk(sceneGroup: THREE.Group, x: number, z: number, active: boolean) {
  const desk = new THREE.Group()
  desk.position.set(x, 0, z)

  // Modern sit-stand desk: slim top + brushed metal legs + dual ultrawide monitors.
  const desktop = new THREE.Mesh(
    new THREE.BoxGeometry(1.95, 0.09, 0.9),
    material(0x2a3a44, 0.38, 0.22),
  )
  desktop.position.y = 0.84
  desk.add(desktop)

  const edgeGlow = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 0.02, 0.03),
    new THREE.MeshBasicMaterial({
      color: active ? 0x5ee1f2 : 0x7a93a0,
      transparent: true,
      opacity: active ? 0.85 : 0.35,
    }),
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
  let primaryScreen: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | null = null
  for (const offsetX of dualOffsets) {
    const monitorBack = new THREE.Mesh(
      new THREE.BoxGeometry(0.78, 0.5, 0.06),
      material(0x0f1724, 0.4, 0.22),
    )
    monitorBack.position.set(offsetX, 1.32, -0.24)
    monitorBack.rotation.x = -0.05
    desk.add(monitorBack)

    const screenMaterial = new THREE.MeshStandardMaterial({
      color: active ? 0xa8e8ff : 0x5f758c,
      emissive: active ? 0x0e4f66 : 0x0b1220,
      emissiveIntensity: active ? 1.25 : 0.22,
      roughness: 0.32,
    })
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.4), screenMaterial)
    screen.position.set(offsetX, 1.32, -0.2)
    desk.add(screen)
    if (!primaryScreen) primaryScreen = screen

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

  const lampGlow = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 10, 8),
    new THREE.MeshBasicMaterial({
      color: active ? 0xb8f0ff : 0xf4dfad,
      transparent: true,
      opacity: active ? 0.95 : 0.55,
    }),
  )
  lampGlow.position.set(0.84, 1.24, -0.06)
  desk.add(lampGlow)

  // Floating status beacon above the desk when the agent is running.
  if (active) {
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 }),
    )
    beacon.position.set(0, 1.72, -0.22)
    desk.add(beacon)
  }

  sceneGroup.add(desk)
  return primaryScreen!
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

  const shirtFront = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.32, 0.025),
    material(0xe8eef1, 0.82),
  )
  shirtFront.position.set(0, 1.39, 0.246)
  group.add(shirtFront)

  const badge = new THREE.Mesh(
    new THREE.BoxGeometry(0.095, 0.13, 0.02),
    new THREE.MeshBasicMaterial({ color: STATUS_COLORS[worker.statusTone] }),
  )
  badge.position.set(0.13, 1.43, 0.267)
  group.add(badge)

  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.085, 0.095, 0.17, 10),
    skinMaterial,
  )
  neck.position.y = 1.68
  group.add(neck)

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

function disposeScene(scene: THREE.Scene) {
  scene.traverse((object) => {
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
    const interiorLighting = night || resolvedPhase === "dusk" || resolvedPhase === "dawn"
    const light = PHASE_LIGHTING[resolvedPhase]

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: variant === "full",
        alpha: false,
        powerPreference: "high-performance",
        preserveDrawingBuffer: variant === "full",
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

    const edgeDistrict = addEdgeDistrict({
      scene,
      totalWidth,
      totalDepth,
      timeOfDay: resolvedTimeOfDay,
      timePhase: resolvedPhase,
      light,
      variant,
    })
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
    renderer.domElement.dataset.rooftopOffice = "true"
    host.dataset.cityBuildingCount = String(edgeDistrict.counts.buildings)

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
      const aspect = Math.max(0.35, host.clientWidth / Math.max(1, host.clientHeight))
      const portraitMix = 1 - THREE.MathUtils.smoothstep(aspect, 0.62, 1.12)
      camera.fov = THREE.MathUtils.lerp(36, variant === "thumbnail" ? 48 : 54, portraitMix)
      camera.updateProjectionMatrix()
      yaw = edgeDistrict.framing.yaw
      pitch = edgeDistrict.framing.pitch
      distance = THREE.MathUtils.lerp(
        edgeDistrict.framing.landscapeDistance,
        edgeDistrict.framing.portraitDistance,
        portraitMix,
      )
      target.copy(edgeDistrict.framing.target)
      target.y += portraitMix * 2.8
      updateCamera()
    }
    resetCameraRef.current = resetCamera
    resetCamera()

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
      const workLightIntensity = working ? (night ? 8.2 : 5.6) : night ? 4.8 : 3.4
      if (interiorLighting) {
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
        material(departmentIndex === 0 ? 0x34414b : 0x4f5a61, 0.86, 0.02),
      )
      carpet.position.y = -0.01
      carpet.receiveShadow = variant === "full"
      tagObject(carpet, { departmentId: department.id })
      departmentGroup.add(carpet)
      selectables.push(carpet)

      const stripeColor = ACTIVITY_COLORS[department.workers[0]?.activity || (department.id === "ceo-office" ? "coordination" : "software")]
      const zoneEdgeMaterial = new THREE.MeshStandardMaterial({
        color: departmentIndex === 0 ? 0xb9dce4 : 0x8f9ca2,
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
            showLabel:
              variant === "full" &&
              (worker.active || worker.statusTone === "attention"),
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
      const boardStatus = new THREE.Mesh(
        new THREE.CircleGeometry(0.1, 18),
        new THREE.MeshBasicMaterial({
          color: working ? STATUS_COLORS.active : STATUS_COLORS.ready,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        }),
      )
      boardStatus.position.set(
        boardWidth * 0.37,
        1.52,
        -zoneDepth / 2 + 0.476,
      )
      departmentGroup.add(boardStatus)

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
      distance = THREE.MathUtils.clamp(
        distance + event.deltaY * 0.018,
        edgeDistrict.framing.minDistance,
        edgeDistrict.framing.maxDistance,
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

      if (animation.locomotion) {
        if (!motion) return
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

    const animate = (timestamp: number) => {
      animationFrame = window.requestAnimationFrame(animate)
      if (
        readyReported &&
        (document.visibilityState !== "visible" || (variant === "thumbnail" && pausedRef.current))
      ) {
        return
      }
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
        const { oceanGeometry, oceanPosition, oceanBase, beacon } = edgeDistrict
        for (let index = 0; index < oceanPosition.count; index += 1) {
          const x = oceanPosition.getX(index)
          const depth = oceanBase[index]
          const wave =
            Math.sin(elapsed * 0.72 + x * 0.11 + depth * 0.07) * 0.12 +
            Math.sin(elapsed * 0.43 - x * 0.05 + depth * 0.14) * 0.07
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
      frameCount += 1
      renderer.domElement.dataset.frameCount = String(frameCount)
      if (workers[0] && frameCount % 6 === 0) {
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
      delete host.dataset.cityBuildingCount
    }
  }, [modelSignature, timeOfDay, timePhase, variant])

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
