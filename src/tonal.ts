/** Pure helpers for shaping Tonal API payloads (no I/O). */

export type ActivitySummary = {
  id: string;
  name: string;
  timestamp: string;
  durationSeconds: number;
  timeUnderTensionSeconds: number;
  totalVolumeLbs: number;
  totalReps: number;
  targetArea: string;
  guided: boolean;
  inProgram: boolean;
};

export type SetDetail = {
  movementId: string;
  movementName: string;
  setGroup?: number;
  blockNumber?: number | null;
  reps?: number;
  avgWeightLbs?: number;
  oneRepMaxLbs?: number;
  onMachineVolumeLbs?: number;
  romInches?: number;
};

export type ActivityDetail = {
  id: string;
  beginTime: string;
  endTime?: string | null;
  totalDurationSeconds?: number;
  activeDurationSeconds?: number;
  totalSets?: number;
  totalReps?: number;
  totalVolumeLbs?: number;
  sets: SetDetail[];
};

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/** Map activity-summaries rows (defensive across observed field aliases). */
export function summarizeActivities(raw: unknown[]): ActivitySummary[] {
  return raw.map((item) => {
    const a = (item ?? {}) as Record<string, unknown>;
    return {
      id: String(a.id ?? ""),
      name: String(a.name ?? "Workout"),
      timestamp: String(a.timestamp ?? a.UTCTimestamp ?? a.localTimestamp ?? ""),
      durationSeconds: num(a.duration) ?? 0,
      timeUnderTensionSeconds: num(a.timeUnderTension) ?? 0,
      totalVolumeLbs: num(a.totalVolume) ?? 0,
      totalReps: num(a.totalReps) ?? 0,
      targetArea: String(a.targetArea ?? ""),
      guided: Boolean(a.isGuidedWorkout),
      inProgram: Boolean(a.isInProgram),
    };
  });
}

/** Map workout-activities list rows. */
export function summarizeActivityList(raw: unknown[]): Array<{
  id: string;
  beginTime: string;
  totalSets: number;
  totalReps: number;
  totalVolumeLbs: number;
}> {
  return raw.map((item) => {
    const a = (item ?? {}) as Record<string, unknown>;
    return {
      id: String(a.id ?? ""),
      beginTime: String(a.beginTime ?? ""),
      totalSets: num(a.totalSets) ?? 0,
      totalReps: num(a.totalReps) ?? 0,
      totalVolumeLbs: num(a.totalVolume) ?? 0,
    };
  });
}

/** Detail one workout-activity with movement names + per-set weights. */
export function detailActivity(
  raw: Record<string, unknown>,
  movementNames: Map<string, string>,
): ActivityDetail {
  const setsRaw = Array.isArray(raw.workoutSetActivity) ? raw.workoutSetActivity
    : Array.isArray(raw.workoutSetActivities) ? raw.workoutSetActivities
    : [];
  const sets: SetDetail[] = setsRaw.map((item) => {
    const s = (item ?? {}) as Record<string, unknown>;
    const movementId = String(s.movementId ?? "");
    return {
      movementId,
      movementName: movementNames.get(movementId) ?? "Unknown movement",
      setGroup: num(s.setGroup),
      blockNumber: num(s.blockNumber) ?? null,
      reps: num(s.repCount) ?? num(s.repetition),
      avgWeightLbs: num(s.avgWeight),
      oneRepMaxLbs: num(s.oneRepMax),
      onMachineVolumeLbs: num(s.totalOnMachineVolume),
      romInches: num(s.romLengthIn),
    };
  });
  return {
    id: String(raw.id ?? ""),
    beginTime: String(raw.beginTime ?? ""),
    endTime: str(raw.endTime) ?? null,
    totalDurationSeconds: num(raw.totalDuration),
    activeDurationSeconds: num(raw.activeDuration),
    totalSets: num(raw.totalSets),
    totalReps: num(raw.totalReps),
    totalVolumeLbs: num(raw.totalVolume),
    sets,
  };
}

/** Compact Tonal formatted workout summary. */
export function summarizeFormattedWorkout(raw: Record<string, unknown>) {
  const movementSets = Array.isArray(raw.movementSets) ? raw.movementSets : [];
  return {
    name: str(raw.name) ?? "Workout",
    coachName: str(raw.coachName) ?? null,
    targetArea: str(raw.targetArea) ?? "",
    inProgram: Boolean(raw.isInProgram),
    guided: Boolean(raw.isGuidedWorkout),
    durationSeconds: num(raw.duration),
    timeUnderTensionSeconds: num(raw.timeUnderTension),
    movements: movementSets.map((item) => {
      const m = (item ?? {}) as Record<string, unknown>;
      return {
        movementName: str(m.movementName) ?? "Unknown",
        blockNumber: num(m.blockNumber),
        setGroup: num(m.setGroup),
        totalVolumeLbs: num(m.totalVolume),
        onMachineVolumeLbs: num(m.totalOnMachineVolume),
        setCount: Array.isArray(m.sets) ? m.sets.length : undefined,
      };
    }),
  };
}

export function filterMovements(
  movements: Array<{ id: string; name: string; shortName?: string; muscleGroups?: string[]; bodyRegion?: string }>,
  query: string,
  limit = 25,
) {
  const q = query.trim().toLowerCase();
  const matched = q
    ? movements.filter((m) =>
        m.name.toLowerCase().includes(q)
        || (m.shortName?.toLowerCase().includes(q) ?? false)
        || (m.bodyRegion?.toLowerCase().includes(q) ?? false)
        || (m.muscleGroups?.some((g) => g.toLowerCase().includes(q)) ?? false))
    : movements;
  return matched.slice(0, limit);
}

/* ---------- Custom workout (write path) helpers ---------- */

export type SetIn = {
  movement_id: string;
  block_number: number;
  block_start: boolean;
  set_group: number;
  round: number;
  repetition: number;
  repetition_total: number;
  weight_percentage?: number;
  prescribed_reps?: number | null;
  prescribed_duration?: number | null;
  description?: string;
};

/** Tool-facing set -> Tonal API set. Nulls are omitted (Tonal rejects null optionals). */
export function toApiSet(s: SetIn): Record<string, unknown> {
  const out: Record<string, unknown> = {
    movementId: s.movement_id,
    blockNumber: s.block_number,
    blockStart: s.block_start,
    setGroup: s.set_group,
    round: s.round,
    repetition: s.repetition,
    repetitionTotal: s.repetition_total,
    weightPercentage: Math.round(s.weight_percentage ?? 100), // must be a JSON integer
    dropSet: false,
    burnout: false,
    spotter: false,
    eccentric: false,
    chains: false,
    flex: false,
    warmUp: false,
    description: s.description ?? "",
  };
  if (s.prescribed_reps != null) out.prescribedReps = s.prescribed_reps;
  if (s.prescribed_duration != null) out.prescribedDuration = s.prescribed_duration;
  return out;
}

/** Tonal API set -> tool-facing set (round-trips straight back into update_workout). */
export function fromApiSet(raw: Record<string, unknown>) {
  return {
    movement_id: String(raw.movementId ?? ""),
    prescribed_reps: num(raw.prescribedReps) ?? null,
    prescribed_duration: num(raw.prescribedDuration) ?? null,
    weight_percentage: num(raw.weightPercentage) ?? 100,
    block_number: num(raw.blockNumber) ?? 0,
    block_start: Boolean(raw.blockStart),
    set_group: num(raw.setGroup) ?? 1,
    round: num(raw.round) ?? 1,
    repetition: num(raw.repetition) ?? 1,
    repetition_total: num(raw.repetitionTotal) ?? 1,
    description: str(raw.description) ?? "",
  };
}

const minutes = (seconds: unknown): number | null =>
  typeof seconds === "number" && Number.isFinite(seconds) ? Math.round(seconds / 6) / 10 : null;

export function summarizeUserWorkout(raw: Record<string, unknown>) {
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    publish_state: String(raw.publishState ?? ""),
    duration_min: minutes(raw.duration),
    movement_count: Array.isArray(raw.movementIds) ? raw.movementIds.length : 0,
    created_at: str(raw.createdAt) ?? null,
  };
}

export function detailUserWorkout(raw: Record<string, unknown>) {
  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? ""),
    description: str(raw.description) ?? "",
    publish_state: String(raw.publishState ?? ""),
    duration_min: minutes(raw.duration),
    sets: (Array.isArray(raw.sets) ? raw.sets : []).map((s) => fromApiSet((s ?? {}) as Record<string, unknown>)),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

type CatalogMovement = {
  id: string; name: string; muscleGroups?: string[]; bodyRegion?: string; pushPull?: string;
  family?: string; onMachine?: boolean; inFreeLift?: boolean; skillLevel?: number; isGeneric?: boolean;
};

const catalogEntry = (m: CatalogMovement) => ({
  id: m.id,
  name: m.name,
  muscle_groups: m.muscleGroups ?? [],
  body_region: m.bodyRegion ?? "",
  push_pull: m.pushPull ?? "",
  family: m.family ?? "",
  on_machine: m.onMachine ?? false,
  in_free_lift: m.inFreeLift ?? false,
  skill_level: m.skillLevel ?? 0,
  is_generic: Boolean(m.isGeneric),
});

export function listExercises(
  all: CatalogMovement[],
  f: { muscle_group?: string; body_region?: string; push_pull?: string; family?: string;
       on_machine?: boolean; query?: string; limit?: number },
) {
  let r = all;
  if (f.muscle_group) { const t = f.muscle_group.toLowerCase(); r = r.filter((m) => (m.muscleGroups ?? []).some((g) => g.toLowerCase() === t)); }
  if (f.body_region) r = r.filter((m) => (m.bodyRegion ?? "").toLowerCase() === f.body_region!.toLowerCase());
  if (f.push_pull) r = r.filter((m) => (m.pushPull ?? "").toLowerCase() === f.push_pull!.toLowerCase());
  if (f.family) r = r.filter((m) => (m.family ?? "").toLowerCase() === f.family!.toLowerCase());
  if (f.on_machine !== undefined) r = r.filter((m) => m.onMachine === f.on_machine);
  if (f.query) { const t = norm(f.query); r = r.filter((m) => norm(m.name).includes(t)); }
  return r.slice(0, f.limit ?? 50).map(catalogEntry);
}

/** Ranked name lookup: exact > prefix > all-words > substring. */
export function findMovement(all: CatalogMovement[], name: string, limit = 5) {
  const q = norm(name);
  const words = q.split(" ").filter(Boolean);
  const scored = all.map((m) => {
    const n = norm(m.name);
    const score = n === q ? 4 : n.startsWith(q) ? 3 : words.length && words.every((w) => n.includes(w)) ? 2 : n.includes(q) ? 1 : 0;
    return { m, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.m.name.length - b.m.name.length);
  return scored.slice(0, limit).map(({ m, score }) => ({
    movement_id: m.id, name: m.name, on_machine: m.onMachine ?? false, match: ["", "substring", "all_words", "prefix", "exact"][score],
  }));
}

/* ---------- Schedule / calendar ---------- */

export function summarizeCalendar(raw: unknown, from?: string, to?: string, includeRecommendations = false) {
  const days = Array.isArray((raw as { dailySchedules?: unknown })?.dailySchedules)
    ? ((raw as { dailySchedules: unknown[] }).dailySchedules)
    : [];
  return days
    .map((d) => {
      const day = (d ?? {}) as Record<string, unknown>;
      const tiles = Array.isArray(day.tiles) ? day.tiles : [];
      const items = tiles
        .map((t) => {
          const x = (t ?? {}) as Record<string, unknown>;
          return {
            signup_id: str(x.workoutSignupId) ?? null,
            type: str(x.type) ?? "",
            title: str(x.title) ?? "",
            duration_min: typeof x.duration === "number" ? Math.round(x.duration / 6) / 10 : null,
            completed: Boolean(x.completed),
            workout_id: str(x.workoutId) ?? null,
            target_area: str(x.targetArea) ?? null,
            level: str(x.level) ?? null,
          };
        })
        .filter((w) => includeRecommendations || w.signup_id !== null || w.completed || w.type.startsWith("DAILY_LIFT"));
      return {
        date: String(day.date ?? "").slice(0, 10),
        recommendation_type: includeRecommendations ? (str(day.recommendationType) ?? null) : undefined,
        workouts: items,
      };
    })
    .filter((d) => (!from || d.date >= from) && (!to || d.date <= to))
    .filter((d) => includeRecommendations || d.workouts.length > 0);
}
