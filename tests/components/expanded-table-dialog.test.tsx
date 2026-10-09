import { useState } from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach, describe, it, expect } from 'vitest'
import { ExpandedTableDialog } from '@/components/chat/expanded-table-dialog'

afterEach(cleanup)
describe('expanded table keyboard accessibility', () => {
  it('exposes one named modal, traps tab focus, closes on Escape and restores the activating button', async () => {
    function Fixture() {
      const [open,setOpen]=useState(false)
      const [trigger,setTrigger]=useState<HTMLElement|null>(null)
      return <><button onClick={event=>{setTrigger(event.currentTarget);setOpen(true)}}>Ampliar</button><button>Otro</button>
        <ExpandedTableDialog open={open} onOpenChange={setOpen} restoreFocus={trigger} title="Resultados" headers={['A']} rows={[["1"]]} /></>
    }
    render(<Fixture />)
    const trigger=screen.getByText('Ampliar'); trigger.focus(); fireEvent.click(trigger)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog',{name:'Resultados'})).toHaveAttribute('aria-modal','true')
    const close=screen.getByText('Cerrar'); close.focus()
    fireEvent.keyDown(close,{key:'Tab'})
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close,{key:'Escape'})
    await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(()=>expect(document.activeElement).toBe(trigger))
  })
})
