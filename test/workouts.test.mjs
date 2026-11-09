import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { detailUserWorkout, findMovement, fromApiSet, listExercises, toApiSet } from "../src/tonal.ts";

const base = { movement_id: "m1", block_number: 1, block_start: true, set_group: 1, round: 1, repetition: 1, repetition_total: 3 };

describe("toApiSet", () => {
  test("defaults weight to integer 100 and omits null optionals", () => {
    const out = toApiSet({ ...base, prescribed_reps: 10, prescribed_duration: null });
    assert.equal(out.weightPercentage, 100);
    assert.equal(out.prescribedReps, 10);
    assert.ok(!("prescribedDuration" in out));
    assert.equal(out.movementId, "m1");
  });
  test("weight is always an integer", () => {
    assert.equal(Number.isInteger(toApiSet({ ...base, prescribed_reps: 5, weight_percentage: 62.6 }).weightPercentage), true);
  });
});

describe("fromApiSet round trip", () => {
  test("get_workout output feeds back into toApiSet", () => {
    const api = { movementId: "m1", prescribedDuration: 30, blockNumber: 2, blockStart: true, setGroup: 1, round: 1, repetition: 1, repetitionTotal: 2 };
    const set = fromApiSet(api);
    assert.equal(set.prescribed_reps, null);
    assert.equal(set.prescribed_duration, 30);
    const back = toApiSet(set);
    assert.equal(back.prescribedDuration, 30);
    assert.ok(!("prescribedReps" in back));
    assert.equal(back.blockNumber, 2);
  });
});

describe("detailUserWorkout", () => {
  test("missing sets (archived) yields empty list", () => {
    const d = detailUserWorkout({ id: "w", title: "T", publishState: "archived", duration: 600 });
    assert.deepEqual(d.sets, []);
    assert.equal(d.duration_min, 10);
  });
});

const catalog = [
  { id: "1", name: "Cat-Cow", family: "ActiveRecovery", muscleGroups: ["Back"], onMachine: false },
  { id: "2", name: "Barbell Bench Press", family: "Press", muscleGroups: ["Chest", "Triceps"], bodyRegion: "UpperBody", pushPull: "Push", onMachine: true },
  { id: "3", name: "Bench Press Narrow", family: "Press", muscleGroups: ["Triceps"], onMachine: true },
];

describe("listExercises / findMovement", () => {
  test("query ignores punctuation", () => assert.equal(listExercises(catalog, { query: "cat cow" })[0].id, "1"));
  test("filters combine", () => assert.deepEqual(listExercises(catalog, { muscle_group: "chest", push_pull: "push" }).map((m) => m.id), ["2"]));
  test("exact beats substring", () => {
    const r = findMovement(catalog, "Barbell Bench Press");
    assert.equal(r[0].movement_id, "2");
    assert.equal(r[0].match, "exact");
  });
});
