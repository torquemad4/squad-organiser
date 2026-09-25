// Priced tick-list extras: totals, formatting and descriptions.

import type { ExtraField, PricedItem, Tournament } from "./db";

export function formatMoney(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** The currency of the tournament's first priced field, if it has one. */
export function currencyOf(fields: ExtraField[]): string {
  return fields.find((f) => f.type === "items")?.currency ?? "EUR";
}

export function hasPricedItems(fields: ExtraField[]): boolean {
  return fields.some((f) => f.type === "items");
}

export function selectedItems(field: ExtraField, value: string | undefined): PricedItem[] {
  const keys = new Set((value ?? "").split(",").filter(Boolean));
  return (field.items ?? []).filter((i) => keys.has(i.key));
}

export function extrasTotal(fields: ExtraField[], extras: Record<string, string>): number {
  let total = 0;
  for (const f of fields) if (f.type === "items") for (const i of selectedItems(f, extras[f.key])) total += i.price;
  return total;
}

/** Human-readable answer to one extra question. */
export function describeExtra(field: ExtraField, value: string | undefined): string {
  if (field.type === "items") return selectedItems(field, value).map((i) => i.label).join(", ");
  if (field.type === "checkbox") return value ? "Yes" : "";
  return value ?? "";
}

/** What one coach owes: the ticket plus their ticked extras. */
export function personTotal(t: Pick<Tournament, "ticket_price_cents">, fields: ExtraField[], extras: Record<string, string>): number {
  return (t.ticket_price_cents ?? 0) + extrasTotal(fields, extras);
}

/** Whether this tournament has anything to pay for. */
export function hasCharges(t: Pick<Tournament, "ticket_price_cents">, fields: ExtraField[]): boolean {
  return t.ticket_price_cents !== null || hasPricedItems(fields);
}
