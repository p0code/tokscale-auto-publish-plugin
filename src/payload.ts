import { addTokens, type DayUsage, roundCost } from "./aggregate.ts";
import {
  CLIENT_VERSION,
  type DailyContribution,
  type TokenBreakdown,
  tokenTotal,
  type TokscaleSubmission,
} from "./tokscale.ts";

const ZERO: TokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

/** Tokscale's 0-4 heat level: a day's cost relative to the costliest day sent. */
export function intensity(cost: number, maxCost: number): number {
  if (cost <= 0 || maxCost <= 0) return 0;
  const ratio = cost / maxCost;
  return ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : 1;
}

function contribution(day: DayUsage): Omit<DailyContribution, "intensity"> {
  const tokenBreakdown = day.models.reduce((sum, model) => addTokens(sum, model.tokens), ZERO);
  const incomplete = day.models.some((model) => model.costIncomplete);
  return {
    date: day.date,
    totals: {
      tokens: tokenTotal(tokenBreakdown),
      cost: roundCost(day.models.reduce((sum, model) => sum + model.cost, 0)),
      messages: day.models.reduce((sum, model) => sum + model.messages, 0),
      ...(incomplete ? { costIsComplete: false as const } : {}),
    },
    tokenBreakdown,
    clients: day.models.map((model) => ({
      client: model.client,
      modelId: model.model,
      tokens: model.tokens,
      cost: model.cost,
      messages: model.messages,
    })),
  };
}

/**
 * The exact body POSTed to `/api/submit`. It carries per-day, per-model totals and an opaque
 * device id; nothing else about the machine or the work leaves it.
 */
export function buildSubmission(input: {
  readonly days: ReadonlyArray<DayUsage>;
  readonly device: { readonly id: string; readonly name: string };
  readonly generatedAt: string;
}): TokscaleSubmission | null {
  const days = input.days.toSorted((a, b) => a.date.localeCompare(b.date));
  const first = days[0];
  const last = days.at(-1);
  if (first === undefined || last === undefined) return null;

  const partial = days.map(contribution);
  const maxCost = Math.max(...partial.map((day) => day.totals.cost));
  const contributions = partial.map((day) => ({
    ...day,
    intensity: intensity(day.totals.cost, maxCost),
  }));
  const totalTokens = contributions.reduce((sum, day) => sum + day.totals.tokens, 0);
  const totalCost = roundCost(contributions.reduce((sum, day) => sum + day.totals.cost, 0));

  const years = new Map<string, Array<DailyContribution>>();
  for (const day of contributions) {
    const year = day.date.slice(0, 4);
    years.set(year, [...(years.get(year) ?? []), day]);
  }

  return {
    meta: {
      generatedAt: input.generatedAt,
      version: CLIENT_VERSION,
      dateRange: { start: first.date, end: last.date },
    },
    device: { id: input.device.id, name: input.device.name },
    summary: {
      totalTokens,
      totalCost,
      totalDays: contributions.length,
      activeDays: contributions.length,
      averagePerDay: roundCost(totalCost / contributions.length),
      maxCostInSingleDay: maxCost,
      clients: [...new Set(days.flatMap((day) => day.models.map((m) => m.client)))].toSorted(),
      models: [...new Set(days.flatMap((day) => day.models.map((m) => m.model)))].toSorted(),
    },
    years: [...years.entries()].map(([year, yearDays]) => ({
      year,
      totalTokens: yearDays.reduce((sum, day) => sum + day.totals.tokens, 0),
      totalCost: roundCost(yearDays.reduce((sum, day) => sum + day.totals.cost, 0)),
      range: { start: yearDays[0]?.date ?? year, end: yearDays.at(-1)?.date ?? year },
    })),
    contributions,
  };
}
