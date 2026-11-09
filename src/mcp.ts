import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env } from "./env.js";
import {
  detailActivity,
  detailUserWorkout,
  findMovement,
  listExercises,
  summarizeCalendar,
  summarizeUserWorkout,
  toApiSet,
  filterMovements,
  summarizeActivities,
  summarizeActivityList,
  summarizeFormattedWorkout,
} from "./tonal.js";

const output = (value: unknown, isError = false) => ({
  isError,
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const run = async (op: () => Promise<unknown>) => {
  try { return output(await op()); }
  catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
};

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00.000Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

type SessionStub = { api(path: string, init?: RequestInit): Promise<unknown> };
type CalDay = { date?: string; tiles?: Array<Record<string, unknown>>; recommendationType?: string };

/** Tonal's calendar endpoint rejects ranges over ~4 weeks, so query in 28-day windows and merge. */
async function calendarWindows(
  s: SessionStub, userId: string, start: string, end: string,
  flags: { recent: boolean; recommendations: boolean; dailyLift: boolean },
  stopWhen?: (days: CalDay[]) => boolean,
): Promise<CalDay[]> {
  const byDate = new Map<string, CalDay>();
  const today = new Date().toISOString().slice(0, 10);
  // Tonal rejects upcomingStartDate in the past (recent activity is returned alongside upcoming days).
  for (let from = start < today ? today : start; from <= end; from = addDays(from, 28)) {
    const to = addDays(from, 27) < end ? addDays(from, 27) : end;
    const qs = new URLSearchParams({
      upcomingStartDate: from, upcomingEndDate: to,
      includeRecentActivities: String(flags.recent),
      includeRecommendations: String(flags.recommendations),
      includeDailyLift: String(flags.dailyLift),
    });
    const cal = await s.api(`/users/${userId}/calendar?${qs}`) as { dailySchedules?: CalDay[] };
    const days = cal?.dailySchedules ?? [];
    for (const d of days) {
      const key = String(d.date ?? "").slice(0, 10);
      const prev = byDate.get(key);
      byDate.set(key, prev ? { ...prev, tiles: [...(prev.tiles ?? []), ...(d.tiles ?? [])] } : d);
    }
    if (stopWhen?.(days)) break;
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

const session = () => env().TONAL_SESSION.getByName("owner");

const setSchema = z.object({
  movement_id: z.string().min(1).describe("Tonal movement id (from find_movement/list_exercises)"),
  block_number: z.number().int().min(1).describe("Block index; sets sharing a block_number are a superset"),
  block_start: z.boolean().describe("true on the first set of each block"),
  set_group: z.number().int().min(1).describe("1-indexed exercise position within the block"),
  round: z.number().int().min(1).describe("Which round of the block this set belongs to"),
  repetition: z.number().int().min(1).describe("Which set number of this exercise (1..repetition_total)"),
  repetition_total: z.number().int().min(1).describe("Total sets/rounds of this exercise"),
  weight_percentage: z.number().int().min(0).optional().describe("Percent of working weight (default 100; ~50 for warm-ups). Must be an integer"),
  prescribed_reps: z.number().int().min(0).nullable().optional().describe("Reps (alternating moves need total both sides). Use this OR prescribed_duration"),
  prescribed_duration: z.number().int().min(0).nullable().optional().describe("Seconds, for duration-based movements. Use this OR prescribed_reps"),
  description: z.string().optional().describe("Required to name the exercise when the movement is_generic (Handle/Rope/Bar/Ankle Strap Move)"),
});

export async function createMcpServer(): Promise<McpServer> {
  const server = new McpServer({ name: "tonal-mcp", version: "0.1.0" }, {
    instructions:
      "Unofficial Tonal fitness MCP for one account. Read history with get_recent_workouts then get_workout_activity_details (volumes are pounds). Build custom workouts with list_exercises/find_movement -> estimate_workout_duration -> create_workout; edit with get_workout -> update_workout (full replace); delete_workout archives. Calendar: get_schedule, schedule_workout, reschedule_workout, unschedule_workout.",
  });

  server.tool(
    "get_recent_workouts",
    "List recent completed workouts with name, volume, reps, duration, and target area (newest first).",
    { limit: z.number().int().min(1).max(100).optional().describe("Max workouts to return (default 10)") },
    ({ limit }) => run(async () => {
      const s = session();
      const userId = await s.getUserId();
      const raw = await s.api(`/users/${userId}/activity-summaries`) as unknown[];
      const all = summarizeActivities(Array.isArray(raw) ? raw : []);
      all.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
      return all.slice(0, limit ?? 10);
    }),
  );

  server.tool(
    "list_workout_activities",
    "Page through completed workout activities (API is oldest-first; this tool re-sorts each page newest-first). Prefer get_recent_workouts for recent history.",
    {
      offset: z.number().int().min(0).optional().describe("API offset (default 0 = oldest page)"),
      limit: z.number().int().min(1).max(100).optional().describe("Page size (default 20, max 100)"),
    },
    ({ offset, limit }) => run(async () => {
      const s = session();
      const userId = await s.getUserId();
      const off = offset ?? 0;
      const lim = limit ?? 20;
      const raw = await s.api(`/users/${userId}/workout-activities`, {
        headers: { "pg-offset": String(off), "pg-limit": String(lim) },
      }) as unknown[];
      const page = summarizeActivityList(Array.isArray(raw) ? raw : []);
      page.sort((a, b) => Date.parse(b.beginTime) - Date.parse(a.beginTime));
      return {
        offset: off,
        limit: lim,
        count: page.length,
        nextOffset: page.length === lim ? off + lim : null,
        activities: page,
      };
    }),
  );

  server.tool(
    "get_workout_activity_details",
    "Get one completed workout with every performed set: movement name, reps, average weight (lbs), and volume. Use activity id from get_recent_workouts or list_workout_activities.",
    { activity_id: z.string().min(1).describe("Workout activity id") },
    ({ activity_id }) => run(async () => {
      const s = session();
      const [userId, movements] = await Promise.all([s.getUserId(), s.getMovements()]);
      const names = new Map(movements.map((m) => [m.id, m.name]));
      const raw = await s.api(
        `/users/${userId}/workout-activities/${encodeURIComponent(activity_id)}`,
      ) as Record<string, unknown>;
      return detailActivity(raw ?? {}, names);
    }),
  );

  server.tool(
    "get_workout_summary",
    "Get Tonal's formatted workout summary (coach, target area, per-movement volume).",
    { activity_id: z.string().min(1).describe("Workout activity id") },
    ({ activity_id }) => run(async () => {
      const s = session();
      const userId = await s.getUserId();
      const raw = await s.api(
        `/users/${userId}/workout-summaries/${encodeURIComponent(activity_id)}`,
      ) as Record<string, unknown>;
      return summarizeFormattedWorkout(raw ?? {});
    }),
  );

  server.tool(
    "get_user_stats",
    "Lifetime volume/workout statistics plus current streak.",
    {},
    () => run(async () => {
      const s = session();
      const userId = await s.getUserId();
      const statistics = await s.api(`/users/${userId}/statistics`);
      let streak: unknown = null;
      try { streak = await s.api(`/users/${userId}/streaks/current`); } catch { /* optional */ }
      return { statistics, streak };
    }),
  );

  server.tool(
    "get_muscle_readiness",
    "Current muscle-group readiness percentages (0–100) for recovery planning.",
    {},
    () => run(async () => {
      const s = session();
      const userId = await s.getUserId();
      return s.api(`/users/${userId}/muscle-readiness/current`);
    }),
  );

  server.tool(
    "get_strength_scores",
    "Current strength scores by body region (Overall / Upper / Lower / Core).",
    {},
    () => run(async () => {
      const s = session();
      const userId = await s.getUserId();
      return s.api(`/users/${userId}/strength-scores/current`);
    }),
  );

  server.tool(
    "search_movements",
    "Search the Tonal movement catalog by name, muscle group, or body region.",
    {
      query: z.string().min(1).describe("Substring to match against movement name/muscles"),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 25)"),
    },
    ({ query, limit }) => run(async () => filterMovements(await session().getMovements(), query, limit ?? 25)),
  );


  server.tool(
    "get_schedule",
    "Workouts scheduled on your Tonal calendar for a date range (default: today through 14 days out), grouped by date. Each scheduled item has a signup_id: use it with reschedule_workout or unschedule_workout. Tonal's own suggestions are excluded unless include_recommendations=true. Past dates include completed sessions.",
    {
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("First date YYYY-MM-DD (default: today)"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last date YYYY-MM-DD (default: from + 14 days)"),
      include_recommendations: z.boolean().optional().describe("Also return Tonal's suggested tiles (default false)"),
      raw: z.boolean().optional().describe("Return Tonal's raw calendar JSON"),
    },
    ({ from, to, include_recommendations, raw }) => run(async () => {
      const s = session();
      const userId = await s.getUserId();
      const start = from ?? new Date().toISOString().slice(0, 10);
      const end = to ?? addDays(start, 14);
      if (end < start) throw new Error("to must be on or after from");
      if (Date.parse(end) - Date.parse(start) > 120 * 86_400_000) throw new Error("Range too large: ask for 120 days or fewer.");
      const days = await calendarWindows(s, userId, start, end,
        { recent: true, recommendations: true, dailyLift: true });
      const data = { dailySchedules: days };
      if (raw) return data;
      return summarizeCalendar(data, start, end, Boolean(include_recommendations));
    }),
  );

  server.tool(
    "schedule_workout",
    "Schedule one of your custom workouts (workout_id from list_workouts or create_workout) on your Tonal calendar for a date. A workout can only be scheduled on one date at a time; move it with reschedule_workout. Returns the signup_id.",
    {
      workout_id: z.string().min(1),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
    },
    ({ workout_id, date }) => run(async () => {
      const s = session();
      const userId = await s.getUserId();
      const r = await s.api(`/users/${userId}/workout-signups?forWorkoutScheduling=true`, {
        method: "POST",
        body: JSON.stringify({ workoutId: workout_id, plannedDate: `${date}T00:00:00.000Z` }),
      }) as Record<string, unknown> | undefined;
      const signup_id = (r?.workoutSignupId ?? r?.id) as string | undefined;
      return { scheduled: true, date, workout_id, signup_id: signup_id ?? null, tonal_response: r ?? null };
    }),
  );

  server.tool(
    "unschedule_workout",
    "Remove a scheduled workout from your Tonal calendar. Takes the signup_id from get_schedule. This only removes it from the calendar; the workout itself is not deleted.",
    { signup_id: z.string().min(1) },
    ({ signup_id }) => run(async () => {
      const s = session();
      const userId = await s.getUserId();
      await s.api(`/users/${userId}/workout-signups/${encodeURIComponent(signup_id)}`, { method: "DELETE" });
      return { unscheduled: true, signup_id };
    }),
  );

  server.tool(
    "reschedule_workout",
    "Move a scheduled workout to a different date. Tonal has no in-place edit, so this removes the signup and creates a new one (the signup_id changes); if the new date fails it restores the original. Takes the signup_id from get_schedule. Only upcoming signups (today through ~6 months out) can be found; pass workout_id for anything else.",
    {
      signup_id: z.string().min(1),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("New date YYYY-MM-DD"),
      workout_id: z.string().optional().describe("Skip the calendar lookup by passing the workout id"),
    },
    ({ signup_id, date, workout_id }) => run(async () => {
      const s = session();
      const userId = await s.getUserId();
      let workoutId = workout_id;
      let oldDate: string | undefined;
      {
        const start = new Date().toISOString().slice(0, 10);
        const days = await calendarWindows(s, userId, start, addDays(start, 180),
          { recent: false, recommendations: false, dailyLift: false },
          (ds) => ds.some((d) => (d.tiles ?? []).some((t) => t.workoutSignupId === signup_id)));
        for (const day of days) {
          const tile = (day.tiles ?? []).find((t) => t.workoutSignupId === signup_id);
          if (tile) { workoutId = workoutId ?? (tile.workoutId as string); oldDate = String(day.date ?? "").slice(0, 10); break; }
        }
      }
      if (!workoutId) throw new Error("Could not find that signup_id on the calendar; pass workout_id to reschedule it.");
      if (oldDate === date) return { rescheduled: false, reason: "already on that date", signup_id, date };
      const base = `/users/${userId}/workout-signups`;
      await s.api(`${base}/${encodeURIComponent(signup_id)}`, { method: "DELETE" });
      const create = (d: string) => s.api(`${base}?forWorkoutScheduling=true`, {
        method: "POST", body: JSON.stringify({ workoutId, plannedDate: `${d}T00:00:00.000Z` }),
      }) as Promise<Record<string, unknown> | undefined>;
      try {
        const r = await create(date);
        return { rescheduled: true, from: oldDate ?? null, to: date, workout_id: workoutId, signup_id: (r?.workoutSignupId ?? r?.id) ?? null };
      } catch (error) {
        let restored = false;
        if (oldDate) { try { await create(oldDate); restored = true; } catch { /* reported below */ } }
        throw new Error(`Could not schedule ${date}: ${error instanceof Error ? error.message : String(error)}. Original date ${restored ? "was restored" : "could NOT be restored; call schedule_workout to put it back"}.`);
      }
    }),
  );

  server.tool(
    "list_exercises",
    "Browse Tonal's exercise catalog to choose movements. Filters combine with AND. body_region: UpperBody/LowerBody/Core (often blank). push_pull: Push/Pull (often blank). family e.g. Squat, Lunge, Row; stretches/warm-ups are family ActiveRecovery. is_generic entries (Handle/Rope/Bar/Ankle Strap Move) are freeform slots: name them via the set's description. family=Rest is a real rest-period movement.",
    {
      muscle_group: z.string().optional(), body_region: z.string().optional(), push_pull: z.string().optional(),
      family: z.string().optional(), on_machine: z.boolean().optional(),
      query: z.string().optional().describe("Name substring; punctuation-insensitive (cat cow matches Cat-Cow)"),
      limit: z.number().int().min(1).max(400).optional().describe("Default 50"),
    },
    (f) => run(async () => listExercises(await session().getMovements(), f)),
  );

  server.tool(
    "find_movement",
    "Look up a movement_id by exercise name, ranked exact > prefix > all-words > substring. The catalog has many near-duplicate variants: check name and on_machine before trusting a non-exact match. A movement_id is required for every set.",
    { name: z.string().min(1), limit: z.number().int().min(1).max(25).optional().describe("Default 5") },
    ({ name, limit }) => run(async () => findMovement(await session().getMovements(), name, limit ?? 5)),
  );

  server.tool(
    "list_workouts",
    "List your own custom Tonal workouts (not Tonal's coach library), newest first. Use to find ids for get_workout/update_workout/delete_workout. publish_state is archived for deleted ones. The list has no set counts; use movement_count or call get_workout.",
    { limit: z.number().int().min(1).max(200).optional().describe("Default 25") },
    ({ limit }) => run(async () => {
      const raw = await session().api("/user-workouts") as unknown[];
      const all = (Array.isArray(raw) ? raw : []).map((w) => summarizeUserWorkout((w ?? {}) as Record<string, unknown>));
      all.sort((a, b) => (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0));
      return all.slice(0, limit ?? 25);
    }),
  );

  server.tool(
    "get_workout",
    "Full detail of one custom workout with every set and its block/superset structure. Fetch before update_workout; the returned sets can be passed straight back. Archived workouts return no sets (Tonal behavior); delete_workout returns a snapshot instead.",
    { workout_id: z.string().min(1) },
    ({ workout_id }) => run(async () =>
      detailUserWorkout(await session().api(`/workouts/${encodeURIComponent(workout_id)}`) as Record<string, unknown>)),
  );

  server.tool(
    "estimate_workout_duration",
    "Estimate duration (seconds) of a candidate set list without creating anything.",
    { sets: z.array(setSchema).min(1) },
    ({ sets }) => run(async () => {
      const r = await session().api("/user-workouts/estimate", { method: "POST", body: JSON.stringify(sets.map(toApiSet)) }) as { duration?: number };
      return { duration_sec: r?.duration ?? null };
    }),
  );

  server.tool(
    "create_workout",
    "Create a new custom workout on the user's Tonal. Each set needs a movement_id and exactly one of prescribed_reps / prescribed_duration; which one a movement requires varies, and a wrong choice returns Tonal's own error (e.g. programmed as reps but must be duration). weight_percentage defaults to 100 and resolves on the machine. Rest periods use the Rest movement; freeform work uses generic movements named via description. Run estimate_workout_duration first if length matters.",
    { title: z.string().min(1), sets: z.array(setSchema).min(1), description: z.string().optional() },
    ({ title, sets, description }) => run(async () => {
      const r = await session().api("/user-workouts", { method: "POST", body: JSON.stringify({
        title, sets: sets.map(toApiSet), createdSource: "WorkoutBuilder", shortDescription: "", description: description ?? "",
      }) }) as Record<string, unknown>;
      return { id: r?.id, title: r?.title ?? title, duration_min: typeof r?.duration === "number" ? Math.round(r.duration / 6) / 10 : null };
    }),
  );

  server.tool(
    "update_workout",
    "REPLACE a custom workout's title and full set list (not a partial patch). Call get_workout first and pass back the complete set list you want.",
    { workout_id: z.string().min(1), title: z.string().min(1), sets: z.array(setSchema).min(1), description: z.string().optional() },
    ({ workout_id, title, sets, description }) => run(async () => {
      const s = session();
      const existing = await s.api(`/workouts/${encodeURIComponent(workout_id)}`) as Record<string, unknown>;
      const r = await s.api(`/user-workouts/${encodeURIComponent(workout_id)}`, { method: "PUT", body: JSON.stringify({
        id: workout_id, title, description: description || (existing?.description as string) || "",
        coachId: (existing?.coachId as string) || "00000000-0000-0000-0000-000000000000",
        sets: sets.map(toApiSet), level: (existing?.level as string) || "",
        assetId: (existing?.assetId as string) || "", createdSource: "WorkoutBuilder",
      }) }) as Record<string, unknown>;
      return { id: r?.id ?? workout_id, title: r?.title ?? title, duration_min: typeof r?.duration === "number" ? Math.round(r.duration / 6) / 10 : null };
    }),
  );

  server.tool(
    "delete_workout",
    "Archive a custom workout (soft delete: publish_state becomes archived). Tonal stops returning sets for archived workouts, so this response includes a snapshot of the title and sets taken just before archiving. Keep it if you may want to recreate the workout.",
    { workout_id: z.string().min(1) },
    ({ workout_id }) => run(async () => {
      const s = session();
      const id = encodeURIComponent(workout_id);
      const before = detailUserWorkout(await s.api(`/workouts/${id}`) as Record<string, unknown>);
      await s.api(`/user-workouts/${id}`, { method: "DELETE" });
      const after = await s.api(`/workouts/${id}`) as Record<string, unknown>;
      return { id: workout_id, publish_state: String(after?.publishState ?? ""), title: before.title, sets: before.sets };
    }),
  );

  return server;
}
