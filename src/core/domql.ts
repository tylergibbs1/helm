/**
 * DomQL — SQL-like query engine for the DOM.
 * Adapted from https://github.com/tylergibbs1/domql to run against
 * an existing Playwright Page instead of launching its own browser.
 */

import type { Page } from "playwright";

// ============================================================================
// Types
// ============================================================================

export interface ParsedQuery {
  fields: DomqlField[];
  selector: string;
  where?: WhereClause;
  orderBy?: OrderBy;
  limit?: number;
  aggregations?: Aggregation[];
}

export interface DomqlField {
  name: string;
  type: "text" | "attr" | "nested";
  attr?: string;
  nested?: string;
}

export interface WhereClause {
  field: string;
  operator: string;
  value: any;
  logic?: "AND" | "OR";
  next?: WhereClause;
}

interface OrderBy {
  field: string;
  direction: "ASC" | "DESC";
}

interface Aggregation {
  function: "COUNT" | "AVG" | "MIN" | "MAX" | "SUM";
  field?: string;
  alias?: string;
}

export interface DomqlResult {
  fields: string[];
  rows: any[][];
  rowCount: number;
  selector: string;
}

// ============================================================================
// Main Entry — runs query against an existing Playwright Page
// ============================================================================

export async function runDomql(page: Page, sql: string): Promise<DomqlResult> {
  const query = parseQuery(sql);

  // Run the DOM portion inside the browser
  const raw = await page.evaluate(
    ({ query }) => {
      const elements = Array.from(document.querySelectorAll(query.selector));
      const rows: any[][] = [];

      elements.forEach((el) => {
        const row: any[] = [];

        query.fields.forEach(
          (field: { type: string; attr?: string; nested?: string }) => {
            let value: any = null;

            if (field.type === "text") {
              value = el.textContent?.trim() || "";
            } else if (field.type === "attr" && field.attr) {
              value = el.getAttribute(field.attr) || "";
            } else if (field.type === "nested" && field.nested) {
              const nested = el.querySelector(field.nested);
              value = nested?.textContent?.trim() || "";
            }

            row.push(value);
          }
        );

        rows.push(row);
      });

      return {
        fields: query.fields.map((f: { name: string }) => f.name),
        rows,
      };
    },
    { query }
  );

  // Post-process in Node (WHERE, ORDER BY, LIMIT, aggregations)
  let filteredRows = raw.rows;

  if (query.where) {
    filteredRows = filterRows(filteredRows, raw.fields, query.where);
  }

  if (query.aggregations && query.aggregations.length > 0) {
    const agg = executeAggregations(filteredRows, raw.fields, query);
    return { ...agg, rowCount: agg.rows[0]?.length ?? 0, selector: query.selector };
  }

  if (query.orderBy) {
    const idx = raw.fields.indexOf(query.orderBy.field);
    if (idx !== -1) {
      const dir = query.orderBy.direction;
      filteredRows.sort((a: any[], b: any[]) => {
        const aVal = coerceValue(a[idx]);
        const bVal = coerceValue(b[idx]);
        const cmp = aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
        return dir === "DESC" ? -cmp : cmp;
      });
    }
  }

  if (query.limit) {
    filteredRows = filteredRows.slice(0, query.limit);
  }

  return {
    fields: raw.fields,
    rows: filteredRows,
    rowCount: filteredRows.length,
    selector: query.selector,
  };
}

// ============================================================================
// SQL Parser
// ============================================================================

export function parseQuery(query: string): ParsedQuery {
  query = query.replace(/\s+/g, " ").trim();

  const selectMatch = query.match(/SELECT\s+(.+?)\s+FROM/i);
  if (!selectMatch) {
    throw new Error("Invalid query: missing SELECT clause");
  }

  const fieldsStr = selectMatch[1]!;
  const fields = parseFields(fieldsStr);
  const aggregations = parseAggregations(fieldsStr);

  const fromMatch = query.match(
    /FROM\s+"([^"]+)"|FROM\s+\[([^\]]+)\]|FROM\s+([^\s]+)/i
  );
  if (!fromMatch) {
    throw new Error("Invalid query: missing FROM clause");
  }
  const selector = fromMatch[1] || fromMatch[2] || fromMatch[3]!;

  const whereMatch = query.match(
    /WHERE\s+(.+?)(?:\s+ORDER BY|\s+LIMIT|$)/i
  );
  const where = whereMatch ? parseWhere(whereMatch[1]!) : undefined;

  const orderMatch = query.match(/ORDER BY\s+(\w+)\s*(ASC|DESC)?/i);
  const orderBy = orderMatch
    ? {
        field: orderMatch[1]!,
        direction: (orderMatch[2]?.toUpperCase() || "ASC") as "ASC" | "DESC",
      }
    : undefined;

  const limitMatch = query.match(/LIMIT\s+(\d+)/i);
  const limit = limitMatch ? parseInt(limitMatch[1]!) : undefined;

  return {
    fields,
    selector,
    where,
    orderBy,
    limit,
    aggregations: aggregations.length > 0 ? aggregations : undefined,
  };
}

function parseFields(fieldsStr: string): DomqlField[] {
  const fields: DomqlField[] = [];
  const parts = fieldsStr.split(",").map((s) => s.trim());

  for (const part of parts) {
    if (/^(COUNT|AVG|MIN|MAX|SUM)\(/i.test(part)) continue;

    if (part.toLowerCase() === "text") {
      fields.push({ name: "text", type: "text" });
    } else if (part.startsWith("@")) {
      fields.push({ name: part.substring(1), type: "attr", attr: part.substring(1) });
    } else if (part.startsWith(".")) {
      fields.push({ name: part, type: "nested", nested: part });
    } else {
      fields.push({ name: part, type: "text" });
    }
  }

  return fields;
}

function parseAggregations(fieldsStr: string): Aggregation[] {
  const aggregations: Aggregation[] = [];
  const aggRegex =
    /(COUNT|AVG|MIN|MAX|SUM)\(([^)]*)\)(?:\s+AS\s+(\w+))?/gi;
  let match;
  while ((match = aggRegex.exec(fieldsStr)) !== null) {
    aggregations.push({
      function: match[1]!.toUpperCase() as Aggregation["function"],
      field: match[2] || undefined,
      alias: match[3] || match[1]!.toLowerCase(),
    });
  }
  return aggregations;
}

function parseWhere(whereStr: string): WhereClause | undefined {
  const parts = whereStr.split(/\s+(AND|OR)\s+/i);
  let root: WhereClause | undefined;
  let current: WhereClause | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!.trim();
    if (part.toUpperCase() === "AND" || part.toUpperCase() === "OR") continue;

    const clause = parseWhereCondition(part);
    if (!clause) continue;

    if (!root) {
      root = clause;
      current = root;
    } else {
      current!.next = clause;
      clause.logic = (parts[i - 1]?.toUpperCase() as "AND" | "OR") || "AND";
      current = clause;
    }
  }

  return root;
}

function parseWhereCondition(condition: string): WhereClause | null {
  const normalizeField = (f: string) => f.replace(/^@/, "");

  const inMatch = condition.match(/@?([\w-]+)\s+IN\s+\(([^)]+)\)/i);
  if (inMatch) {
    const values = inMatch[2]!.split(",").map((v) => {
      const val = v.trim().replace(/^['"]|['"]$/g, "");
      if (/^\d+$/.test(val)) return parseInt(val);
      if (/^\d+\.\d+$/.test(val)) return parseFloat(val);
      return val;
    });
    return { field: normalizeField(inMatch[1]!), operator: "IN", value: values };
  }

  const notRegexpMatch = condition.match(
    /@?([\w-]+)\s+NOT\s+(?:REGEXP|RLIKE)\s+'([^']+)'/i
  );
  if (notRegexpMatch) {
    return { field: normalizeField(notRegexpMatch[1]!), operator: "NOT REGEXP", value: notRegexpMatch[2]! };
  }

  const regexpMatch = condition.match(
    /@?([\w-]+)\s+(?:REGEXP|RLIKE)\s+'([^']+)'/i
  );
  if (regexpMatch) {
    return { field: normalizeField(regexpMatch[1]!), operator: "REGEXP", value: regexpMatch[2]! };
  }

  const notLikeMatch = condition.match(
    /@?([\w-]+)\s+NOT\s+LIKE\s+'([^']+)'/i
  );
  if (notLikeMatch) {
    return { field: normalizeField(notLikeMatch[1]!), operator: "NOT LIKE", value: notLikeMatch[2]! };
  }

  const likeMatch = condition.match(/@?([\w-]+)\s+LIKE\s+'([^']+)'/i);
  if (likeMatch) {
    return { field: normalizeField(likeMatch[1]!), operator: "LIKE", value: likeMatch[2]! };
  }

  const compMatch = condition.match(/@?([\w-]+)\s*(=|!=|>=|<=|>|<)\s*(.+)/);
  if (compMatch) {
    let value: any = compMatch[3]!.replace(/^['"]|['"]$/g, "").trim();
    if (/^\d+$/.test(value)) value = parseInt(value);
    else if (/^\d+\.\d+$/.test(value)) value = parseFloat(value);
    return { field: normalizeField(compMatch[1]!), operator: compMatch[2]!, value };
  }

  return null;
}

// ============================================================================
// Post-processing (runs in Node, not browser)
// ============================================================================

function filterRows(
  rows: any[][],
  fields: string[],
  where: WhereClause
): any[][] {
  return rows.filter((row) => evaluateWhere(row, fields, where));
}

function evaluateWhere(
  row: any[],
  fields: string[],
  where: WhereClause
): boolean {
  const fieldIndex = fields.indexOf(where.field);
  if (fieldIndex === -1) return true;

  const value = coerceValue(row[fieldIndex]);
  const compareValue = coerceValue(where.value);

  let result = false;

  switch (where.operator) {
    case "=":
      result = value === compareValue;
      break;
    case "!=":
      result = value !== compareValue;
      break;
    case ">":
      result = value > compareValue;
      break;
    case "<":
      result = value < compareValue;
      break;
    case ">=":
      result = value >= compareValue;
      break;
    case "<=":
      result = value <= compareValue;
      break;
    case "LIKE": {
      const str = String(value).toLowerCase();
      const search = String(compareValue).toLowerCase();
      if (search.startsWith("%") && search.endsWith("%")) {
        result = str.includes(search.slice(1, -1));
      } else if (search.startsWith("%")) {
        result = str.endsWith(search.slice(1));
      } else if (search.endsWith("%")) {
        result = str.startsWith(search.slice(0, -1));
      } else {
        result = str === search;
      }
      break;
    }
    case "NOT LIKE": {
      const str = String(value).toLowerCase();
      const search = String(compareValue).toLowerCase();
      if (search.startsWith("%") && search.endsWith("%")) {
        result = !str.includes(search.slice(1, -1));
      } else if (search.startsWith("%")) {
        result = !str.endsWith(search.slice(1));
      } else if (search.endsWith("%")) {
        result = !str.startsWith(search.slice(0, -1));
      } else {
        result = str !== search;
      }
      break;
    }
    case "IN": {
      const inValues = Array.isArray(compareValue)
        ? compareValue
        : String(compareValue)
            .split(",")
            .map((v: string) => coerceValue(v.trim()));
      result = inValues.some((v: any) => v === value);
      break;
    }
    case "REGEXP": {
      try {
        const regex = parseRegex(String(compareValue));
        result = regex.test(String(value));
      } catch {
        result = false;
      }
      break;
    }
    case "NOT REGEXP": {
      try {
        const regex = parseRegex(String(compareValue));
        result = !regex.test(String(value));
      } catch {
        result = false;
      }
      break;
    }
  }

  if (where.next) {
    const nextResult = evaluateWhere(row, fields, where.next);
    if (where.next.logic === "AND") {
      result = result && nextResult;
    } else if (where.next.logic === "OR") {
      result = result || nextResult;
    }
  }

  return result;
}

function parseRegex(pattern: string): RegExp {
  const slashMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  if (slashMatch) return new RegExp(slashMatch[1]!, slashMatch[2]);

  const flagMatch = pattern.match(/^\(\?([gimsuy]+)\)(.+)$/);
  if (flagMatch) return new RegExp(flagMatch[2]!, flagMatch[1]);

  return new RegExp(pattern);
}

function coerceValue(value: any): any {
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) return parseInt(value);
    if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      const date = new Date(value);
      if (!isNaN(date.getTime())) return date;
    }
  }
  return value;
}

function executeAggregations(
  rows: any[][],
  fields: string[],
  query: ParsedQuery
): { fields: string[]; rows: any[][] } {
  const results: any[] = [];
  const aggFields: string[] = [];

  for (const agg of query.aggregations!) {
    aggFields.push(agg.alias || agg.function.toLowerCase());

    if (agg.function === "COUNT") {
      results.push(rows.length);
    } else if (agg.field) {
      const idx = fields.indexOf(agg.field);
      if (idx !== -1) {
        const values = rows
          .map((r) => coerceValue(r[idx]))
          .filter((v): v is number => typeof v === "number");

        switch (agg.function) {
          case "AVG":
            results.push(
              values.length > 0
                ? values.reduce((a, b) => a + b, 0) / values.length
                : null
            );
            break;
          case "MIN":
            results.push(
              values.length > 0
                ? values.reduce((a, b) => Math.min(a, b))
                : null
            );
            break;
          case "MAX":
            results.push(
              values.length > 0
                ? values.reduce((a, b) => Math.max(a, b))
                : null
            );
            break;
          case "SUM":
            results.push(
              values.length > 0 ? values.reduce((a, b) => a + b, 0) : null
            );
            break;
        }
      } else {
        results.push(null);
      }
    }
  }

  return { fields: aggFields, rows: [results] };
}
