declare module '@novnc/novnc/lib/rfb.js' {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: Record<string, unknown>)
    scaleViewport: boolean
    resizeSession: boolean
    viewOnly: boolean
    addEventListener(type: string, handler: (ev: Event) => void): void
    removeEventListener(type: string, handler: (ev: Event) => void): void
    disconnect(): void
  }
}
