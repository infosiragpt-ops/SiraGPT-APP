declare module "@novnc/novnc" {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: Record<string, unknown>)
    viewOnly: boolean
    scaleViewport: boolean
    clipViewport: boolean
    resizeSession?: boolean
    showDotCursor?: boolean
    addEventListener(type: string, cb: (ev: Event) => void): void
    removeEventListener(type: string, cb: (ev: Event) => void): void
    disconnect(): void
  }
}

declare module "mammoth/mammoth.browser" {
  export function convertToHtml(
    input: { arrayBuffer: ArrayBuffer },
    options?: { styleMap?: string[] },
  ): Promise<{ value: string; messages?: Array<{ message?: string }> }>
}

declare module "react-plotly.js/factory" {
  const createPlotlyComponent: (plotly: unknown) => import("react").ComponentType<any>
  export default createPlotlyComponent
}

declare module "plotly.js-basic-dist-min" {
  const Plotly: unknown
  export default Plotly
}

declare module "turndown" {
  class TurndownService {
    constructor(options?: Record<string, unknown>)
    addRule(
      key: string,
      rule: {
        filter: (node: Node) => boolean
        replacement: (content: string, node: Node) => string
      },
    ): void
    turndown(input: string): string
  }
  export default TurndownService
}
