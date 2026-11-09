# Tonal private API notes

Unofficial and observed, not guaranteed. Base URL `https://api.tonal.com/v6`. Auth: Auth0 password grant
against `https://tonal.auth0.com/oauth/token` (the public client id used by the mobile app); send the **id_token**
as `Authorization: Bearer`. Nothing here is documented by Tonal.

## Custom workouts (`/user-workouts`)

| Operation | Call |
|---|---|
| List yours | `GET /user-workouts` (ignores pagination; no sets in list items) |
| Read one | `GET /workouts/{id}` (archived workouts lose their `sets`) |
| Create | `POST /user-workouts` with `{title, sets[], description, shortDescription, createdSource: "WorkoutBuilder"}` |
| Update (replace) | `PUT /user-workouts/{id}` needs `id, title, description, coachId, assetId, level, sets` (fetch the existing one first) |
| Archive | `DELETE /user-workouts/{id}` (soft delete: `publishState` becomes `archived`) |
| Estimate duration | `POST /user-workouts/estimate` with the **bare sets array** as the body |

Set rules learned the hard way: `weightPercentage` must be a JSON **integer**; use `prescribedReps` or
`prescribedDuration` depending on the movement (Tonal's 400 tells you which); never send `null` optionals.

## Calendar and scheduling

| Operation | Call |
|---|---|
| Read | `GET /users/{id}/calendar?upcomingStartDate=YYYY-MM-DD&upcomingEndDate=YYYY-MM-DD&includeRecentActivities=true&includeRecommendations=true&includeDailyLift=true` |
| Schedule | `POST /users/{id}/workout-signups?forWorkoutScheduling=true` with `{"workoutId": "...", "plannedDate": "YYYY-MM-DDT00:00:00.000Z"}`; returns `{id, ...}` |
| Unschedule | `DELETE /users/{id}/workout-signups/{signupId}` returns 204 |
| Move | **No in-place edit**: `PATCH`, `PUT` and `GET` on `/workout-signups/{id}` all return 404. Delete, then create (the id changes). |

Details that matter:

- The calendar rejects ranges over about **28 days** and rejects an `upcomingStartDate` in the past, so clients
  must query in windows. Recent completed sessions come back alongside the upcoming days.
- Day objects have `date`, `recommendationType` and `tiles[]`. A tile is *scheduled* when it has a
  `workoutSignupId`. Tiles of type `WORKOUT` under a `recommendationType` such as `GOAL`, `QUICK`, `TRENDING`
  or `NEWEST` are Tonal's suggestions, not your schedule. Tile types seen: `CUSTOM_WORKOUT`, `WORKOUT`,
  `DAILY_LIFT_WORKOUT`, `DAILY_LIFT_WORKOUT_SUMMARY`.
- A workout can be scheduled on only one date at a time (the open-source coach app checks for this before posting).
- An invalid or past `plannedDate` gives `400 {"message":"Invalid workout signup"}`.

## Reading data

`/users/userinfo`, `/users/{id}/activity-summaries`, `/users/{id}/workout-activities` (paged with `pg-offset` and
`pg-limit` headers, oldest first), `/users/{id}/muscle-readiness/current`, `/users/{id}/strength-scores/current`,
`/users/{id}/statistics`, `/users/{id}/streaks/current`, and `/movements` (the exercise catalog).
