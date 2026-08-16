# Lumen IoT — project context

One place to pick this project back up from: what exists, how the pieces fit,
**why** each significant decision went the way it did, and what has actually
been proven to work versus merely written.

> No secrets here. The broker password and `JWT_SECRET` live in
> `Lumen-IOT-Backend/.env`, which is gitignored.

---

## 1. The three repositories

| Repo | What it is | State |
| --- | --- | --- |
| `mqtt-broker` | MQTT 3.1.1/5.0 broker written from scratch on Node stdlib. Deployed at `lumeniot.sahajarya.com`. **Pre-existing — not written in this work.** | Live |
| `Lumen-IOT-Backend` | Fastify + Postgres + Redis API. Auth, devices, rooms, automations, scenes, telemetry, MQTT bridge. | Runs locally |
| `Lumen-IOT-App` | Expo / React Native client. | Bundles clean |

### Broker endpoints (fixed, not ours to change)

```
mqtts://lumeniot.sahajarya.com:8883   native MQTT+TLS   firmware, and the backend
wss://lumeniot.sahajarya.com/mqtt     MQTT over WS:443  browsers / RN
https://lumeniot.sahajarya.com/       liveness, 200 RUNNING / 503 DOWN
```

---

## 2. Architecture, and the decision everything else follows from

```
ESP32 ──mqtts:8883──┐
                    ├──►  MQTT broker  ◄──mqtts:8883──  BACKEND  ◄──HTTPS/WSS──  app
ESP32 ──mqtts:8883──┘                                (only credential holder)
```

**The backend is the only MQTT client.** The app holds no broker credentials and
opens no broker connection.

The original app connected straight to the broker using the shared `app`
principal, whose password sat in `src/config.js` and therefore in the shipped
bundle — readable by anyone who installed it, and able to read every device
topic and command every device. Everything since has been about removing that.

A constraint that shaped the early design: **React Native cannot open a raw TLS
socket**, so a phone can never use `mqtts://…:8883`, only the WebSocket
endpoint. Node can, so the backend uses the native one. The CA file
(`isrgrootx1.pem`) is a firmware concern; bundling it into the app does nothing.

---

## 3. Decision log

Chronological. Each entry could reasonably have gone the other way.

1. **App transport = `wss://…/mqtt`, not `:8883`.** RN can't do raw TLS. Later
   made moot — the app no longer speaks MQTT at all.
2. **Backend owns the broker credential.** The fix for the shipped-password
   problem; drove everything downstream.
3. **Postgres + Redis, no ORM.** Raw SQL with a small query helper and
   forward-only `.sql` migrations, matching the broker repo's no-magic style.
4. **scrypt from `node:crypto`, not argon2/bcrypt.** Same `scrypt$N$salt$hash`
   format the broker's `users.json` already uses, so one credential format
   covers both systems, and no native dependency to build.
5. **Rotating opaque refresh tokens.** Replaying a rotated token revokes the
   whole family.
6. **Automations run server-side.** The phone is a remote control, never the
   control loop; rules must work with the app closed.
7. **Automations are per-user, not per-home.** Sharing a home must not mean
   editing a housemate's rules. Ownership is re-checked at *fire* time — §7.
8. **Rule scope is the account, not one home.** A rule may span homes
   ("workshop tank full → stop house pump") and may use one device on both sides.
9. **Device type is immutable after creation.** It decides which controls render
   and which keys a rule may command; changing it later silently invalidates
   existing automations.
10. **Phone + OTP replaced email/password in the app.** Static code for now,
    behind a provider interface — §6.
11. **Rules reshaped to if-this-then-that.** Researched Tuya/SmartLife and IFTTT
    first: they show one IF list with an any/all switch, not
    trigger-plus-conditions. Migration folded each old trigger into
    `conditions[0]` with `match='all'`, preserving behaviour exactly.
12. **Timers deleted entirely.** "On for 20 minutes" was a second, parallel way
    to express time. Timing is now only a schedule condition. *This lost
    relative timing* — §10.
13. **The app became fully backend-driven.** Local device registry, MQTT
    provider, polyfills and the `mqtt`/`buffer`/`process` dependencies deleted.
    Sign-in gates the whole app. Every device is added via the backend.

---

## 4. Data model

```
users ──< home_members >── homes ──< device_groups (rooms)
                              │
                              └──< devices ──< device_state     (latest per key)
                                        │     └< device_readings (history, BRIN)
                                        └──< device_commands   (audit)
homes ──< automations ──< automation_watches  (which devices a rule reads)
      └─< scenes            automation_runs   (shared run log)
```

- `devices.device_uid` is the **MQTT principal id** — the `<id>` in
  `devices/<id>/…`. Unique platform-wide, not per home, so two homes cannot
  claim the same physical device.
- `automations.owner_id` — rules are private to their creator.
- Migrations `001`–`006`, forward-only, applied automatically at boot under an
  advisory lock.

### MQTT topic conventions (backend, broker scripts and firmware all agree)

```
devices/<uid>/status      retained + LWT   "online" / "offline"
devices/<uid>/state       retained         presence word, or {"power":true,…}
devices/<uid>/meta        retained         {"type":…,"capabilities":{…}}
devices/<uid>/telemetry                    {"temp":23.5,"humidity":61}
devices/<uid>/cmd         backend→device   {"power":"on"}  QoS 1, never retained
devices/<uid>/<key>       retained         a single scalar reading
```

Ingest rules that matter:

- **Retained messages are not history.** They are the broker replaying what it
  already held, so they update current state but are never appended to
  `device_readings` — otherwise every reconnect fabricates a data point.
- **Presence follows the Last Will.** An explicit `status` topic wins; otherwise
  inferred from live traffic, going `stale` after `DEVICE_STALE_SECONDS`.
- **An empty retained payload clears the value**, per MQTT convention.
- A `status` payload that is *not* a presence word (`"on"`) is kept as a
  **reading** rather than discarded.

---

## 5. Automation model (if-this-then-that)

```
If     conditions   1..n, combined by  match = any | all
Then   actions      1..n
```

Conditions split by role — this is the load-bearing idea:

| Kind | Role | Notes |
| --- | --- | --- |
| `device` | **fires** | reading vs comparator; optional `clearValue` hysteresis |
| `status` | **fires** | online/offline, backed by the broker's Last Will |
| `schedule` | **fires** | minute of day + weekdays, in the home's timezone. This is how a timer is expressed. |
| `time` | **gates** | a window; never fires on its own |

A **gate narrows even under ANY** — "night OR tank full" must not run the pump at
noon because the window was one of two alternatives. A rule of gates alone is
rejected on write.

Actions: `command`, `scene`, `delay`, `webhook`. A scene may not run a scene.
Targets are picked from the devices already in the account, across every home
the user belongs to; several targets may point at the same device and are
merged into one command patch on save.

### Four guards, because rules drive real hardware

- **Edge triggering** — fires on the false→true crossing of the rule *as a
  whole*, not on every message while true.
- **Hysteresis** (`clearValue`) — fire at 90, re-arm only below 80, so a level
  sitting on the threshold cannot chatter a relay.
- **Cooldown** — claimed in Redis with `SET NX EX`, so two API instances
  ingesting the same message cannot both fire.
- **Chain depth** — an action tags its target; updates from it inherit the depth
  and rules stop at 3. Two rules that trigger each other would ping-pong.

A condition on a device that has **never reported** evaluates false — a rule must
not act on an assumption about a silent sensor.

**Scenes** are presets with no trigger: one tap sets many devices. Also usable as
a rule action, so a button and a rule share one definition.

---

## 6. Auth

- **Phone + OTP** is the only path the app offers. The first successful code
  creates the account and its first home — possession of the number *is*
  registration.
- **The code is currently static and accepted for every number.** Anyone can
  sign in as anyone. It is a stand-in for a gateway, set by `OTP_STATIC_CODE`.
- The API **refuses to boot in production** on the static provider unless
  `OTP_ALLOW_INSECURE_IN_PRODUCTION=true`. Don't set it.
- Everything *around* delivery is already production-shaped: codes stored
  hashed, single use, an attempt limit that kills the challenge, a wrong guess
  does not extend expiry, resend cooldown + hourly ceiling, identical responses
  whether or not the number is registered, masked numbers in logs.
- **Going live is one method**: implement `SmsOtpProvider.deliver` in
  `src/auth/otp.ts` and set `OTP_PROVIDER=sms`. That provider already generates
  a real random code and never returns `debugCode`. No route, schema or client
  change — the app's dev-mode prefill and warning disappear on their own.
- Email + password still exists in the API (`/api/auth/signup`, `/login`) but the
  app no longer uses it. Accounts may hold either identity or both; a phone-only
  account has no password, and the password-confirmed endpoints say so.

---

## 7. Security posture

- No credentials in the app bundle. Verified by grep: no broker host, no `8883`,
  no `wss://`, no password.
- Authorisation funnels through home membership. Non-members get **404, not
  403**, so ids cannot be probed.
- **Automation ownership is re-checked at fire time.** This was a real bug: rules
  were home-owned and nothing re-checked membership, so a rule kept commanding
  hardware after its creator was removed from the home. Now blocked with a
  recorded reason (`owner_left_home`, `owner_read_only`, `device_not_owned`).
- Viewers may watch but never actuate — enforced on the automated path too.
- Rate limiting and Redis both **degrade open** rather than taking the API down.
- Device MQTT passwords are shown once; only the scrypt hash is stored.

---

## 8. Running it locally (verified working)

Neither Docker nor Postgres/Redis existed on this machine; installed via brew.

```bash
brew install postgresql@16 redis
brew services start postgresql@16 && brew services start redis
createuser -s lumen && createdb -O lumen lumen

cd Lumen-IOT-Backend
cp .env.example .env          # set JWT_SECRET and MQTT_PASSWORD
npm install && npm run migrate && npm start
```

**Redis gotcha:** the Redis 8.10 formula ships a `redis.conf` with
`loadmodule ./modules/redisbloom/redisbloom.so` and three siblings, using
relative paths whose `.so` files do not exist — the server aborts on every
start. Those four lines are commented out; backup at
`/opt/homebrew/etc/redis.conf.bak-lumen`.

```bash
cd Lumen-IOT-App
npm install && npm start      # port 8081 was taken here; --port 8083
```

On the phone, set Profile → Backend to the **LAN address**
(`http://192.168.0.198:4000`). `localhost` there means the phone itself. Plain
`http` needs a cleartext exception on a real Android build; Expo Go is fine.

**Everything that runs, runs from `dist/`.** Node's `--experimental-strip-types`
does not rewrite `./x.js` specifiers to `./x.ts`, so executing the sources
directly fails on the first runtime import. `migrate`, `seed`, `dev` and the
tests that need runtime values all build first.

---

## 9. Verified vs not

**Proven live**, against real Postgres/Redis and the real broker:

- OTP request → wrong code rejected → correct code creates account + home →
  authenticated `/api/me` → replay of the consumed code refused
- Device claim; cross-home rules; single-device rules; foreign device refused
- Multi-target rules (three targets, all existing account devices)
- Scene create + tap-to-run; scene-nesting rejected
- ANY/OR rules, schedule conditions, gate-only rules refused
- Migration 006 folding 9 existing rules' triggers into conditions, intact
- All seven endpoints the app depends on returning 200
- MQTT bridge connected, `readyz` green on all three dependencies

**Never executed:**

- **An automation firing from a device message.** Every path around it is
  proven, but the ingest→rule→publish loop has not run, because the `app`
  principal's ACL only permits `devices/+/cmd` — it cannot publish a fake tank
  reading. Closing this needs a device principal:
  `node tools/simulate-device.mjs --id tank-01 --password '<pw>' --type sensor`
- **The app rendering.** No simulator available here. It bundles clean (888
  modules) and the endpoints are verified, but no screen has been seen.
- The realtime WebSocket from the app side.

**Tests:** backend 66 unit tests (pure rule logic, OTP challenge behaviour,
phone normalisation, topic parsing). No integration tests.

---

## 10. Known gaps / next steps

- **Relative timing is gone.** Deleting timers removed "run the fan for 20
  minutes after motion" — a schedule is absolute. The durable-revert machinery
  is in git history if it should come back.
- **No geofence, no push notifications.** Both are in KME Smart's model. Each
  needs app-side infrastructure to supply: background location permission and
  App Store justification; or FCM/APNs credentials plus a device-token table.
- **Raw command sending was removed** from device screens. A device publishing a
  key its type doesn't declare can no longer be commanded from the app unless it
  advertises that key in its `meta` capabilities.
- **ANY rules edge-trigger as a whole**, not per condition. Tank full *then*
  pump offline is one run, not two. Differs from Tuya; safer for hardware.
- The broker still needs `scripts/add-device.mjs` run by hand per device plus a
  `systemctl restart`. The API generates a compatible hash but cannot install it.
- **Device type cannot be corrected** after claiming — only remove and re-claim,
  which loses telemetry history.
- Deleting a device does **not** clean up rules that reference it: the id lives
  inside `conditions`/`actions` JSON with no foreign key, so such a rule dangles
  and fails at fire time. Worth a cascade or a validation sweep.

---

## 11. Bugs found and fixed along the way

Kept because each is a trap that could recur.

| Where | What |
| --- | --- |
| App | Optimistic command values were written into `readings` and never expired — a device echoing under a different key left the requested value pinned forever, so external changes were ignored |
| App | `parseStatusPayload` returning null **overwrote** known-good presence, and a non-presence payload on a `status` topic was discarded entirely |
| App | `isControlOn` compared exactly, so a lock reporting `locked`/`unlocked` always read as unlocked |
| App | Reading lookup was case-sensitive: `devices/x/Power` was invisible to controls |
| App | `Text` doesn't shrink in a row by default — long values ran over their neighbours in three places |
| App | `fontFamily: 'Courier'` does not exist on Android; it substitutes a proportional face and breaks every character-counted layout |
| App | Rule list still read `automation.trigger` after migration 006 dropped it — would have crashed every card |
| Backend | Nothing loaded `.env` outside Docker |
| Backend | `migrate`/`seed`/`dev` could never run (the `.js`→`.ts` resolution problem) |
| Backend | A missing dependency produced a bare `AggregateError` with no hint |
| Backend | `maxRetriesPerRequest: null` made every Redis command hang forever during an outage |
| Backend | Rate limiting failed *closed* on a Redis error — 500s for everything |
| Backend | Scene-nesting guard sat after an early return, so a scene containing only a scene skipped it |
| Backend | Automation ownership was never enforced (§7) |
