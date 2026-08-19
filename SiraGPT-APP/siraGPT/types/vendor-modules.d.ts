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

declare module "three" {
  export class Color {
    constructor(color?: string | number)
  }
}
