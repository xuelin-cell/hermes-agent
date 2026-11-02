export interface SessionListSnapshot<Row = Record<string, unknown>> {
  scope: string
  rows: Row[]
}
