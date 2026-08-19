import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ImageGenerationEffect from '@/components/ImageGenerationEffect'

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: (_target, tag: string) => {
      return ({ children, animate: _animate, transition: _transition, ...props }: any) =>
        React.createElement(tag, props, children)
    },
  }),
}))

vi.mock('lucide-react', () => ({
  Sparkles: (props: any) => <svg data-testid="sparkles-icon" {...props} />,
}))

describe('ImageGenerationEffect', () => {
  it.each([
    ['1:1', '1 / 1', '400px', '250px'],
    ['2:3', '2 / 3', '267px', '167px'],
    ['3:2', '3 / 2', '600px', '375px'],
    ['3:4', '3 / 4', '300px', '188px'],
    ['4:3', '4 / 3', '533px', '333px'],
    ['9:16', '9 / 16', '225px', '141px'],
    ['16:9', '16 / 9', '711px', '444px'],
  ] as const)('sizes the loading frame for %s', (aspectRatio, cssRatio, desktopWidth, mobileWidth) => {
    render(<ImageGenerationEffect aspectRatio={aspectRatio} count={1} />)

    const frame = screen.getByTestId('image-generation-frame')
    expect(frame).toHaveStyle({ aspectRatio: cssRatio })
    expect(frame.style.getPropertyValue('--image-loader-width')).toBe(desktopWidth)
    expect(frame.style.getPropertyValue('--image-loader-width-mobile')).toBe(mobileWidth)
    expect(frame).toHaveTextContent(`Generando·${aspectRatio}`)
  })

  it('renders one minimal frame per requested image', () => {
    render(<ImageGenerationEffect aspectRatio="1:1" count={3} />)

    expect(screen.getAllByTestId('image-generation-frame')).toHaveLength(3)
  })
})
