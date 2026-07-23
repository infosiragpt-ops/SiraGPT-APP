"use client"

import * as React from "react"
import * as THREE from "three"

import type {
  AgentOfficeActivity,
  AgentOfficeModel,
  AgentOfficeWorker,
} from "@/lib/agent-office-model"
import { cn } from "@/lib/utils"

type AgentOfficeSceneProps = {
  model: AgentOfficeModel
  variant?: "full" | "thumbnail"
  paused?: boolean
  selectedWorkerId?: string | null
  resetCameraKey?: number
  className?: string
  onSelectWorker?: (workerId: string) => void
  onSelectDepartment?: (departmentId: string) => void
  onReady?: () => void
}

type WorkerAnimation = {
  worker: AgentOfficeWorker
  group: THREE.Group
  leftArm: THREE.Mesh
  rightArm: THREE.Mesh
  screen: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>
  selectionRing: THREE.Mesh
  phase: number
  baseY: number
  walkStart: THREE.Vector3 | null
  walkEnd: THREE.Vector3 | null
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

function addWorker({
  sceneGroup,
  worker,
  x,
  z,
  workerIndex,
  walking,
}: {
  sceneGroup: THREE.Group
  worker: AgentOfficeWorker
  x: number
  z: number
  workerIndex: number
  walking: boolean
}): WorkerAnimation {
  const group = new THREE.Group()
  group.position.set(x, 0, walking ? z + 1.35 : z + 0.82)
  group.rotation.y = walking ? Math.PI / 2 : Math.PI

  const bodyMaterial = material(ACTIVITY_COLORS[worker.activity], 0.68)
  const skinMaterial = material(0xe5ad66, 0.76)
  const limbMaterial = material(ACTIVITY_COLORS[worker.activity], 0.72)

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.31, 0.62, 12), bodyMaterial)
  body.position.y = walking ? 0.93 : 0.9
  group.add(body)

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 14, 10), skinMaterial)
  head.position.y = 1.37
  group.add(head)

  const statusHalo = new THREE.Mesh(
    new THREE.RingGeometry(0.27, 0.33, 20),
    new THREE.MeshBasicMaterial({
      color: STATUS_COLORS[worker.statusTone],
      transparent: true,
      opacity: worker.active ? 0.95 : 0.55,
      side: THREE.DoubleSide,
    }),
  )
  statusHalo.position.y = 1.61
  statusHalo.rotation.x = Math.PI / 2
  group.add(statusHalo)

  const leftArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.36, 4, 8), limbMaterial)
  leftArm.position.set(-0.28, 0.99, -0.04)
  leftArm.rotation.z = 0.42
  leftArm.rotation.x = walking ? 0 : -0.8
  group.add(leftArm)

  const rightArm = leftArm.clone()
  rightArm.position.x = 0.28
  rightArm.rotation.z = -0.42
  group.add(rightArm)

  const selectionRing = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.5, 28),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
  )
  selectionRing.position.y = 0.025
  selectionRing.rotation.x = -Math.PI / 2
  selectionRing.visible = false
  group.add(selectionRing)

  tagObject(group, { workerId: worker.id, departmentId: worker.departmentId })
  sceneGroup.add(group)

  return {
    worker,
    group,
    leftArm,
    rightArm,
    screen: null as unknown as WorkerAnimation["screen"],
    selectionRing,
    phase: workerIndex * 0.77,
    baseY: group.position.y,
    walkStart: walking ? new THREE.Vector3(x - 1.25, 0, z + 1.35) : null,
    walkEnd: walking ? new THREE.Vector3(x + 1.25, 0, z + 1.35) : null,
  }
}

function disposeScene(scene: THREE.Scene) {
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const current of materials) current.dispose()
  })
}

export function AgentOfficeScene({
  model,
  variant = "full",
  paused = false,
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
  const [failed, setFailed] = React.useState(false)

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
    renderer.setClearColor(variant === "thumbnail" ? 0xdfe8ee : 0xe8edf0, 1)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, variant === "thumbnail" ? 1 : 1.5))
    renderer.shadowMap.enabled = variant === "full"
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
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

    const officeDepartments =
      variant === "thumbnail"
        ? model.departments.filter((department) => department.workers.length > 0).slice(0, 6)
        : model.departments
    const departments = officeDepartments.length > 0 ? officeDepartments : model.departments.slice(0, 4)
    const columns = variant === "thumbnail" ? Math.min(3, Math.max(1, departments.length)) : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(departments.length * 1.35))))
    const rows = Math.max(1, Math.ceil(departments.length / columns))
    const zoneWidth = variant === "thumbnail" ? 7.2 : 9.2
    const zoneDepth = variant === "thumbnail" ? 5.4 : 6.8
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
      pitch = variant === "thumbnail" ? 0.82 : 0.8
      const baseDistance = Math.max(
        variant === "thumbnail" ? 18 : 27,
        Math.max(totalWidth * 0.86, totalDepth * 1.25),
      )
      const aspect = Math.max(0.35, host.clientWidth / Math.max(1, host.clientHeight))
      distance = Math.min(72, baseDistance * Math.max(1, 0.9 / aspect))
      target.set(0, 0.5, 0)
      updateCamera()
    }
    resetCameraRef.current = resetCamera
    resetCamera()

    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x53606a, 1.7)
    scene.add(hemisphere)
    const sun = new THREE.DirectionalLight(0xfff4dd, 2.45)
    sun.position.set(-18, 28, 14)
    sun.castShadow = variant === "full"
    if (variant === "full") {
      sun.shadow.mapSize.set(2048, 2048)
      sun.shadow.camera.left = -30
      sun.shadow.camera.right = 30
      sun.shadow.camera.top = 30
      sun.shadow.camera.bottom = -30
    }
    scene.add(sun)
    const fill = new THREE.DirectionalLight(0xc9e7ff, 1.2)
    fill.position.set(18, 12, -16)
    scene.add(fill)

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(totalWidth + 10, totalDepth + 10),
      material(0xcfbd99, 0.92),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.08
    floor.receiveShadow = variant === "full"
    scene.add(floor)

    const aisle = new THREE.Mesh(
      new THREE.PlaneGeometry(totalWidth + 6, 1.15),
      material(0xc7d1d5, 0.9),
    )
    aisle.rotation.x = -Math.PI / 2
    aisle.position.set(0, -0.035, totalDepth / 2 + 1.6)
    scene.add(aisle)

    const workers: WorkerAnimation[] = []
    const selectables: THREE.Object3D[] = []

    departments.forEach((department, departmentIndex) => {
      const column = departmentIndex % columns
      const row = Math.floor(departmentIndex / columns)
      const zoneX = column * (zoneWidth + gapX) - totalWidth / 2 + zoneWidth / 2
      const zoneZ = row * (zoneDepth + gapZ) - totalDepth / 2 + zoneDepth / 2
      const departmentGroup = new THREE.Group()
      departmentGroup.position.set(zoneX, 0, zoneZ)

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
        const walking = Boolean(worker?.active && deskIndex % 4 === 3 && variant === "full")
        const screen = addDesk(departmentGroup, deskX, deskZ, Boolean(worker?.active))
        addChair(departmentGroup, deskX, deskZ + 0.88)
        if (worker) {
          const animation = addWorker({
            sceneGroup: departmentGroup,
            worker,
            x: deskX,
            z: deskZ,
            workerIndex: workers.length,
            walking,
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

      const boardLight = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.min(3.25, zoneWidth - 1.45), 1.35),
        new THREE.MeshStandardMaterial({
          color: department.activeCount > 0 ? stripeColor : 0x8aa0b2,
          emissive: department.activeCount > 0 ? stripeColor : 0x1f2937,
          emissiveIntensity: department.activeCount > 0 ? 0.42 : 0.08,
          roughness: 0.4,
        }),
      )
      boardLight.position.set(0, 1.18, -zoneDepth / 2 + 0.395)
      tagObject(boardLight, { departmentId: department.id })
      departmentGroup.add(boardLight)
      selectables.push(boardLight)

      scene.add(departmentGroup)
    })

    scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh) {
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
    const clock = new THREE.Clock()
    const projectedWorker = new THREE.Vector3()
    let animationFrame = 0
    let frameCount = 0
    let readyReported = false

    const animate = () => {
      animationFrame = window.requestAnimationFrame(animate)
      const elapsed = clock.getElapsedTime()
      const canAnimate = !pausedRef.current && !reducedMotion && document.visibilityState === "visible"

      for (const animation of workers) {
        animation.selectionRing.visible = selectedWorkerRef.current === animation.worker.id
        if (!canAnimate) continue
        const phase = elapsed * (animation.worker.active ? 3.2 : 1.15) + animation.phase
        animation.group.position.y = animation.baseY + Math.sin(phase) * (animation.worker.active ? 0.025 : 0.012)
        if (animation.walkStart && animation.walkEnd) {
          const progress = (Math.sin(elapsed * 0.72 + animation.phase) + 1) / 2
          animation.group.position.lerpVectors(animation.walkStart, animation.walkEnd, progress)
          animation.group.rotation.y = Math.cos(elapsed * 0.72 + animation.phase) >= 0 ? Math.PI / 2 : -Math.PI / 2
          animation.leftArm.rotation.x = Math.sin(phase) * 0.55
          animation.rightArm.rotation.x = -Math.sin(phase) * 0.55
        } else if (animation.worker.active) {
          animation.leftArm.rotation.x = -0.78 + Math.sin(phase) * 0.16
          animation.rightArm.rotation.x = -0.78 + Math.sin(phase + Math.PI) * 0.16
          animation.screen.material.emissiveIntensity = 0.85 + (Math.sin(phase * 0.5) + 1) * 0.2
        }
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
    animate()

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
  }, [model, variant])

  return (
    <div
      ref={hostRef}
      className={cn("relative h-full min-h-0 w-full overflow-hidden bg-[#e8edf0]", className)}
      data-testid={variant === "thumbnail" ? "agent-office-thumbnail" : "agent-office-scene"}
      data-office-ready="false"
    >
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950 px-6 text-center text-xs text-zinc-300">
          La vista 3D no está disponible en este navegador.
        </div>
      ) : null}
    </div>
  )
}
