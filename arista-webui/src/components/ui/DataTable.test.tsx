import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DataTable } from './DataTable'
import type { DataTableColumn } from './DataTable'

// The VLAN inventory shape inlined today in `src/features/SwitchManager.tsx`, which this primitive
// is extracted for.
type VlanRow = { id: number; name?: string; state?: string }
const columns: readonly DataTableColumn<VlanRow>[] = [
  { header: 'ID', numeric: true, cell: (row) => row.id },
  { header: 'Name', cell: (row) => row.name ?? '—' },
  { header: 'State', cell: (row) => row.state ?? 'Not reported' },
]
const rows: readonly VlanRow[] = [
  { id: 10, name: 'USERS', state: 'active' },
  { id: 20, name: 'VOICE', state: 'active' },
]

const bodyRows = () => screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))

describe('DataTable', () => {
  it('gives every column header the col scope the accessibility checklist requires', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} />)

    const headers = screen.getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual(['ID', 'Name', 'State'])
    for (const header of headers) expect(header).toHaveAttribute('scope', 'col')
  })

  it('renders a real table whose rows and cells follow the declared column order', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} label="VLAN inventory" />)

    expect(screen.getByRole('table', { name: 'VLAN inventory' })).toBeInTheDocument()
    // One header row plus one row per device entry.
    expect(screen.getAllByRole('row')).toHaveLength(3)
    expect(bodyRows()).toEqual([['10', 'USERS', 'active'], ['20', 'VOICE', 'active']])
  })

  it('omits the table label when the container leaves naming to a surrounding heading', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} />)

    expect(screen.getByRole('table')).not.toHaveAttribute('aria-label')
    expect(screen.queryByRole('table', { name: 'VLAN inventory' })).not.toBeInTheDocument()
  })

  it('marks numeric columns with the existing monospaced cell class', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} />)

    expect(screen.getByRole('cell', { name: '20' })).toHaveClass('numeric-cell')
    expect(screen.getByRole('cell', { name: 'VOICE' })).not.toHaveClass('numeric-cell')
  })

  it('keys rows by the rowKey prop, not by position', () => {
    const { rerender } = render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} />)
    const firstIdCell = screen.getByRole('cell', { name: '10' })

    rerender(<DataTable columns={columns} rows={[{ id: 5, name: 'MGMT' }, ...rows]} rowKey={(row) => row.id} />)

    // Index keying would have re-used this node for the new VLAN and rewritten its text.
    expect(firstIdCell).toHaveTextContent('10')
    expect(bodyRows()).toEqual([['5', 'MGMT', 'Not reported'], ['10', 'USERS', 'active'], ['20', 'VOICE', 'active']])
  })

  it('renders headers with no body rows when the container passes an empty list', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(row) => row.id} />)

    expect(screen.getAllByRole('columnheader')).toHaveLength(3)
    expect(screen.queryAllByRole('cell')).toHaveLength(0)
    expect(screen.getAllByRole('row')).toHaveLength(1)
  })

  it('leaves row order exactly as the container delivered it', () => {
    render(<DataTable columns={columns} rows={[...rows].reverse()} rowKey={(row) => row.id} />)

    expect(bodyRows()).toEqual([['20', 'VOICE', 'active'], ['10', 'USERS', 'active']])
  })
})
