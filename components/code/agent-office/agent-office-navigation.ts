/**
 * Office navigation — orbit / fly / walk.
 * Ideas only (not assets) from Matrix.build / Polsia-style HQ explorers:
 * WASD fly, Q/E height, F exit, first-person walk on the rooftop deck.
 */
import * as THREE from "three"

export const OFFICE_PRO_MARKER = "matrix"
export const OFFICE_PRO_BUILD = "office-pro-matrix"

export type AgentOfficeNavMode = "orbit" | "fly" | "walk"

export type AgentOfficeWalkBounds = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  eyeHeight: number
  flyMinY: number
  flyMaxY: number
}

const MOVE_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
])

export function officeNavTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable
}

export function officeNavShouldHandleKey(event: KeyboardEvent): boolean {
  if (officeNavTypingTarget(event.target)) return false
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  return MOVE_KEYS.has(event.code) || event.code === "KeyF"
}

export function createOfficeWalkBounds(
  totalWidth: number,
  totalDepth: number,
): AgentOfficeWalkBounds {
  return {
    minX: -totalWidth / 2 - 5.4,
    maxX: totalWidth / 2 + 5.4,
    minZ: -totalDepth / 2 - 0.35,
    maxZ: totalDepth / 2 + 6.6,
    eyeHeight: 1.64,
    flyMinY: 0.85,
    flyMaxY: 52,
  }
}

export function stepOfficeLocomotion(
  mode: AgentOfficeNavMode,
  position: THREE.Vector3,
  yaw: number,
  pitch: number,
  keys: ReadonlySet<string>,
  dt: number,
  bounds: AgentOfficeWalkBounds,
) {
  if (mode !== "fly" && mode !== "walk") return

  const speed = mode === "fly"
    ? (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 22 : 11)
    : (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 5.4 : 3.15)

  const forward = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(mode === "fly" ? pitch : 0),
    mode === "fly" ? Math.sin(pitch) : 0,
    Math.cos(yaw) * Math.cos(mode === "fly" ? pitch : 0),
  )
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))
  const wish = new THREE.Vector3()

  if (keys.has("KeyW") || keys.has("ArrowUp")) wish.add(forward)
  if (keys.has("KeyS") || keys.has("ArrowDown")) wish.sub(forward)
  if (keys.has("KeyA") || keys.has("ArrowLeft")) wish.sub(right)
  if (keys.has("KeyD") || keys.has("ArrowRight")) wish.add(right)
  if (mode === "fly") {
    if (keys.has("KeyE")) wish.y += 1
    if (keys.has("KeyQ")) wish.y -= 1
  }

  if (wish.lengthSq() > 0) {
    wish.normalize().multiplyScalar(speed * Math.min(0.05, dt))
    position.add(wish)
  }

  if (mode === "walk") {
    position.x = THREE.MathUtils.clamp(position.x, bounds.minX, bounds.maxX)
    position.z = THREE.MathUtils.clamp(position.z, bounds.minZ, bounds.maxZ)
    position.y = bounds.eyeHeight
  } else {
    position.y = THREE.MathUtils.clamp(position.y, bounds.flyMinY, bounds.flyMaxY)
  }
}

export function applyOfficeLook(
  camera: THREE.PerspectiveCamera,
  position: THREE.Vector3,
  yaw: number,
  pitch: number,
) {
  camera.position.copy(position)
  const look = new THREE.Vector3(
    position.x + Math.sin(yaw) * Math.cos(pitch),
    position.y + Math.sin(pitch),
    position.z + Math.cos(yaw) * Math.cos(pitch),
  )
  camera.lookAt(look)
}
