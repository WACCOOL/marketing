/**
 * Shared contract for ingestion parsers. Each parser takes already-extracted
 * sheet rows (the API owns SheetJS) and returns validated rows + collected
 * per-row errors + stats — it never throws on a bad row, so a few malformed
 * rows don't fail the whole file (the same philosophy as bulk.ts's processBulkRow).
 */

export interface ParseError {
  /** 1-based source row number (header = row 1) for operator-friendly errors. */
  rowIndex: number;
  messages: string[];
}

export interface ParseResult<T> {
  valid: T[];
  errors: ParseError[];
  stats: Record<string, number>;
}
