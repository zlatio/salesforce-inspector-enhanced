import { useEffect, useState } from "preact/hooks";
import { ArrowRight, TerminalSquare } from "lucide-preact";
import { orgState } from "../../../lib/org";
import type { DescribeField, DescribeSObjectResult, LookupNames, SfRecord } from "../../../lib/types";
import { fmtDateTime, fmtRelative, plural } from "../../../lib/format";
import { Button, Spinner } from "../../../ui";
import { links, navigate } from "../../router";
import { Value } from "./FieldsTable";

const LIMIT = 50;

interface HistoryRow {
  Id: string;
  CreatedDate: string;
  CreatedById: string;
  CreatedBy?: { Name?: string } | null;
  Field: string;
  DataType?: string;
  OldValue: unknown;
  NewValue: unknown;
}

/** The field-history child object (AccountHistory, Foo__History, OpportunityFieldHistory…) and its parent-id field. */
export function historySource(d: DescribeSObjectResult): { object: string; parentField: string } | null {
  const rels = d.childRelationships ?? [];
  const candidates = d.name.endsWith("__c") ? [d.name.replace(/__c$/, "__History")] : [d.name + "FieldHistory", d.name + "History"];
  const hit = rels.find((r) => r.relationshipName === "Histories") ?? rels.find((r) => candidates.includes(r.childSObject));
  return hit ? { object: hit.childSObject, parentField: hit.field } : null;
}

/** Names the field can be stored under in the history table: standard lookups are tracked as e.g. "Owner", not "OwnerId". */
function trackedNames(f: DescribeField): string[] {
  const names = [f.name];
  if (f.type === "reference" && !f.custom && /Id$/.test(f.name)) names.push(f.name.slice(0, -2));
  return names;
}

export function historyQuery(src: { object: string; parentField: string }, f: DescribeField, recordId: string) {
  const fields = trackedNames(f)
    .map((n) => `'${n}'`)
    .join(", ");
  return `SELECT Id, CreatedDate, CreatedById, CreatedBy.Name, Field, DataType, OldValue, NewValue FROM ${src.object} WHERE ${src.parentField} = '${recordId}' AND Field IN (${fields}) ORDER BY CreatedDate DESC, Id DESC LIMIT ${LIMIT}`;
}

/** Lookup changes are logged twice (ids and names); keep the readable row and attach the ids to it. */
function mergeLookupRows(rows: HistoryRow[]): Array<HistoryRow & { oldId?: unknown; newId?: unknown }> {
  const out: Array<HistoryRow & { oldId?: unknown; newId?: unknown }> = [];
  const idRows = rows.filter((r) => r.DataType === "EntityId");
  const textRows = rows.filter((r) => r.DataType !== "EntityId");
  const used = new Set<HistoryRow>();
  for (const t of textRows) {
    const twin = idRows.find((i) => !used.has(i) && i.CreatedDate === t.CreatedDate && i.CreatedById === t.CreatedById);
    if (twin) used.add(twin);
    out.push({ ...t, oldId: twin?.OldValue, newId: twin?.NewValue });
  }
  for (const i of idRows) if (!used.has(i)) out.push(i);
  return out.sort((a, b) => b.CreatedDate.localeCompare(a.CreatedDate));
}

function normalize(f: DescribeField, v: unknown) {
  if (f.type === "boolean" && typeof v === "string") return v === "true";
  return v;
}

export function FieldHistory({ field: f, describe, record, lookups }: { field: DescribeField; describe: DescribeSObjectResult; record: SfRecord; lookups: LookupNames }) {
  const sf = orgState.value!.sf;
  const src = historySource(describe);
  const recordId = record.Id as string;
  const [state, setState] = useState<{ rows: HistoryRow[] | null; error: string | null; loading: boolean }>({ rows: null, error: null, loading: true });
  const soql = src && !f.calculated ? historyQuery(src, f, recordId) : null;

  useEffect(() => {
    if (!soql) return;
    const ctrl = new AbortController();
    setState({ rows: null, error: null, loading: true });
    sf.query<HistoryRow>(soql, { signal: ctrl.signal }).then(
      (r) => setState({ rows: r.records, error: null, loading: false }),
      (e: Error) => {
        if (e.name !== "AbortError") setState({ rows: null, error: e.message, loading: false });
      },
    );
    return () => ctrl.abort();
    // Re-fetch after a save changes the record.
  }, [soql, record.LastModifiedDate]);

  if (!soql) return null;

  const rows = state.rows ? (f.type === "reference" ? mergeLookupRows(state.rows) : state.rows) : null;

  return (
    <section class="dsec">
      <div class="dsec__title">
        History
        {rows && rows.length > 0 && (
          <span class="muted">
            ({rows.length}
            {state.rows!.length >= LIMIT ? "+" : ""})
          </span>
        )}
        <span class="grow" />
        <Button variant="ghost" size="sm" title={`Query ${src!.object}`} onClick={() => navigate(links.query(soql!))}>
          <TerminalSquare /> Query
        </Button>
      </div>
      {state.loading ? (
        <div class="row subtle fsmall" style={{ gap: 8 }}>
          <Spinner small /> Loading history…
        </div>
      ) : state.error ? (
        <p class="subtle fsmall">Couldn't load history: {state.error}</p>
      ) : !rows?.length ? (
        <p class="subtle fsmall">No recorded changes. Field history tracking may be off for this field, or changes are older than the retention period.</p>
      ) : (
        <ol class="dhist">
          {rows.map((r) => {
            const isText = f.type === "reference" && r.DataType !== "EntityId";
            const show = (v: unknown, id: unknown) =>
              isText ? (
                v == null || v === "" ? (
                  <span class="fnull">No value</span>
                ) : (
                  <span title={id ? String(id) : undefined}>
                    {id ? <a href={links.id(String(id))}>{String(v)}</a> : String(v)}
                  </span>
                )
              ) : (
                <Value f={f} v={normalize(f, v)} lookups={lookups} full />
              );
            const m = r as HistoryRow & { oldId?: unknown; newId?: unknown };
            return (
              <li class="dhist__row" key={r.Id}>
                <div class="dhist__meta">
                  <span title={fmtDateTime(r.CreatedDate)}>{fmtRelative(Date.parse(r.CreatedDate))}</span>
                  <span class="muted"> · </span>
                  <a href={links.user(r.CreatedById)}>{r.CreatedBy?.Name ?? r.CreatedById}</a>
                </div>
                <div class="dhist__change">
                  <span class="dhist__old">{show(r.OldValue, m.oldId)}</span>
                  <ArrowRight class="dhist__arrow" aria-label="changed to" />
                  <span class="dhist__new">{show(r.NewValue, m.newId)}</span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {rows && state.rows!.length >= LIMIT && <p class="muted fsmall">Showing the latest {plural(LIMIT, "change")}. Use Query to see more.</p>}
    </section>
  );
}
