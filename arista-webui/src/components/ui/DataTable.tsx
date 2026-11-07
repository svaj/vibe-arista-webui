/**
 * F3 (#65) presentation primitive: the generic table behind the inventory-ish screens.
 *
 * Today the only table is the VLAN inventory inlined in `src/features/SwitchManager.tsx`
 * (`<thead><tr><th scope="col">ID</th>…`); interfaces, LAG trunks, ACL lines, static routes and
 * users (#71–#84) all need the same shape. This component renders a real `<table>` with
 * `<th scope="col">` per `.github/references/accessibility-checklist.md` ("Tables have `<th>`
 * headers with scope"), and nothing else: no sorting, no selection, no focus management, no
 * interactive rows — the screens stay keyboard-simple, and anything richer belongs to its own
 * container.
 *
 * Pure props only (no hooks, no fetching). Loading/error/empty decisions stay with the container:
 * an `error` is never rendered through here (that would read as an empty table), and `rows: []`
 * deliberately renders headers with no body rather than inventing an empty state — pair the
 * container's own branch with {@link EmptyState} instead.
 */
import type { ReactNode } from 'react'

export interface DataTableColumn<Row> {
  /** Visible column text. This is also the accessible name of the `<th scope="col">`. */
  readonly header: string
  /** Cell content for one row: a device string verbatim, or composed elements (`StatePill`, …). */
  readonly cell: (row: Row) => ReactNode
  /** Applies the existing `.numeric-cell` class (monospaced, fixed width) to this column's `<td>`s. */
  readonly numeric?: boolean
}

export interface DataTableProps<Row> {
  readonly columns: readonly DataTableColumn<Row>[]
  /** Device order as the container delivered it; this component never sorts or filters. */
  readonly rows: readonly Row[]
  /** Stable React key per row — a device identity (`vlan.id`, `interfaceName`, `session.name`). */
  readonly rowKey: (row: Row) => string | number
  /** Accessible name for the table when no surrounding heading can label the region instead. */
  readonly label?: string
}

export function DataTable<Row>({ columns, rows, rowKey, label }: DataTableProps<Row>) {
  // Column identity for React keys: the header text plus position, which is stable for a
  // statically-declared column list. Row keys must come from `rowKey`, never from position.
  const columnKey = (column: DataTableColumn<Row>, index: number) => `${column.header}-${String(index)}`

  return <div className="table-scroll">
    <table aria-label={label}>
      <thead>
        <tr>{columns.map((column, index) => <th key={columnKey(column, index)} scope="col">{column.header}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row) => <tr key={rowKey(row)}>{columns.map((column, index) => <td key={columnKey(column, index)} className={column.numeric === true ? 'numeric-cell' : undefined}>{column.cell(row)}</td>)}</tr>)}
      </tbody>
    </table>
  </div>
}
