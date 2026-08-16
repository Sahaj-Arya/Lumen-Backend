# Lumen IoT Backend

API, authentication and MQTT bridge for the Lumen IoT platform. Sits between the
[Expo app](../Lumen-IOT-App) and the [MQTT broker](../mqtt-broker) at
`lumeniot.sahajarya.com`.

## Why it exists

The app used to connect straight to the broker with a shared `app` principal
whose password shipped inside the React Native bundle. That principal can read
every device topic and command every device, and anything in a mobile bundle is
readable by whoever installs it.

This backend is the fix. It is the **only** MQTT client:

```
ESP32 ──mqtts:8883──┐
                    ├──►  MQTT broker  ◄──mqtts:8883──  backend  ◄──HTTPS/WSS──  app
ESP32 ──mqtts:8883──┘                                   (only credential holder)
```

Node can open a raw TLS socket, so the backend uses the native `mqtts://…:8883`
endpoint rather than the WebSocket one the phone was limited to. Per-user access
is enforced in the API, not by handing out broker credentials.

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Node 20+, TypeScript, ESM | matches the broker repo |
| HTTP | Fastify 5 | schema-first, fast, good plugin story |
| Durable data | PostgreSQL 16 | relational tenancy + telemetry history |
| Hot data | Redis 7 | sessions, latest device state, rate limits, cross-instance fan-out |
| Passwords | `node:crypto` scrypt | same `scrypt$N$salt$hash` format the broker uses; no native deps |
| Tokens | JWT access + rotating opaque refresh | short-lived access, revocable sessions |

## Run

```bash
cp .env.example .env
# set JWT_SECRET (openssl rand -base64 48) and MQTT_PASSWORD

docker compose up --build          # postgres + redis + api
```

Without Docker (macOS):

```bash
brew install postgresql@16 redis
brew services start postgresql@16 && brew services start redis
createuser -s lumen && createdb -O lumen lumen

npm install
cp .env.example .env          # then set JWT_SECRET and MQTT_PASSWORD
npm run migrate               # applies migrations/*.sql once each, in order
npm run seed                  # optional demo data
npm start                     # or npm run dev for a watch build
```

`.env` is loaded automatically by every script via Node's
`--env-file-if-exists`; there is no dotenv dependency.

> **Everything that runs, runs from `dist/`.** Node's `--experimental-strip-types`
> does not rewrite `./x.js` specifiers to `./x.ts`, so executing the sources
> directly fails on the first runtime import. `migrate`, `seed` and `dev` build
> first.

If a dependency is missing, the API refuses to start with a message naming the
service, the address it tried, and how to start it — rather than a driver stack
trace.

Migrations also run automatically at boot, so a fresh container is ready with no
extra step.

```bash
npm run build       # tsc -> dist/
npm test            # unit tests, no services required
npm run typecheck
```

## API

All routes are JSON. Authenticated routes take `Authorization: Bearer <access>`.

### Auth — `/api/auth`

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/signup` | email + password (min 12 chars), creates the user and their first home |
| GET/POST | `/verify-email` | consume the emailed token |
| POST | `/resend-verification` | throttled to 3/hour |
| POST | `/login` | returns `accessToken`, `refreshToken`, user |
| POST | `/refresh` | rotates the refresh token |
| POST | `/logout` | revokes one refresh token |
| POST | `/logout-all` | revokes every session |
| POST | `/forgot-password` · `/reset-password` | reset flow; reset revokes all sessions |
| POST | `/otp/request` | phone → `{ requestId, expiresInSeconds }` |
| POST | `/otp/verify` | `{ requestId, code }` → tokens; creates the account on first use |

#### Phone + OTP login

```bash
curl -XPOST localhost:4000/api/auth/otp/request \
  -H 'content-type: application/json' -d '{"phone":"+91 98765 43210"}'
# { "requestId":"…", "phone":"********3210", "expiresInSeconds":300, "debugCode":"111111" }

curl -XPOST localhost:4000/api/auth/otp/verify \
  -H 'content-type: application/json' -d '{"requestId":"…","code":"111111"}'
# { "accessToken":"…", "refreshToken":"…", "created":true, "user":{…} }
```

There is no separate phone signup: possession of the number *is* the
registration, so first verify creates the user and their first home.

> **The code is currently static — `111111`, accepted for every number.** That
> means anyone can sign in as anyone. It is a stand-in for a real gateway, and
> the API **refuses to boot in production** on this provider unless
> `OTP_ALLOW_INSECURE_IN_PRODUCTION=true` is set explicitly. Don't set it.

Everything around delivery is already production-shaped, so only delivery is
stubbed:

- codes are stored **hashed** with the phone, never in plaintext
- **single use** — the challenge is deleted on success, so a captured code
  cannot be replayed
- **attempt limit** (`OTP_MAX_ATTEMPTS`) kills the challenge, so a 6-digit code
  cannot be brute-forced; a wrong guess does **not** extend the expiry
- **resend cooldown** + hourly ceiling per number, so nobody can pump messages
  at someone else's phone
- `/otp/request` answers identically whether or not the number has an account,
  so it cannot be used to test who is registered
- responses and logs carry a **masked** number (`********3210`), never the full one

Going live is: implement `SmsOtpProvider.deliver` in
[`src/auth/otp.ts`](src/auth/otp.ts) and set `OTP_PROVIDER=sms`. That provider
already generates a real random code of `OTP_CODE_LENGTH` digits and never
echoes `debugCode`. No route, schema or client change.

Accounts may now hold an email identity, a phone identity, or both — a
phone-only account has no password, and the password-confirmed endpoints say so
rather than failing obscurely.

### Profile — `/api`

`GET /me`, `PATCH /me`, `POST /me/password`, `DELETE /me` (password-confirmed).

### Homes, members, groups — `/api/homes`

CRUD for homes; `:homeId/members` to invite by email with a role; `:homeId/groups`
for rooms. Roles are `owner > admin > member > viewer`, and a home always keeps
at least one owner.

### Devices — `/api/devices`

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/?homeId&groupId` | devices the caller can see |
| GET | `/unclaimed` | ids publishing to the broker that nobody has claimed |
| POST | `/?homeId=…` | claim a device id; returns its MQTT password **once** |
| GET | `/:id` | device + current readings |
| PATCH | `/:id` | rename, retype, regroup, favourite |
| DELETE | `/:id` | unclaim (the hardware keeps publishing) |
| POST | `/:id/credentials` | rotate the device's MQTT password |
| POST | `/:id/commands` | `{"patch":{"state":"ON"}}` → publishes to `devices/<uid>/set` |
| GET | `/:id/commands` | audit trail of commands sent |

### Automations — `/api/automations`

Rules are evaluated **here**, on every ingested device update, so they keep
working with the app closed, uninstalled, or the phone off. The app is a remote
control; it is never the control loop.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/?homeId` | rules the caller can see |
| POST | `/?homeId=…` | create |
| GET/PATCH/DELETE | `/:id` | read, edit, remove |
| POST | `/:id/run` | fire the actions now, ignoring trigger and cooldown |
| GET | `/:id/runs` | history: what fired, what was skipped and why |

A rule is `trigger` + optional `conditions` + ordered `actions`:

```jsonc
{
  "name": "Tank full — stop the pump",
  "trigger": {
    "kind": "state", "deviceId": "<tank>", "key": "level",
    "op": ">", "value": 90,
    "clearValue": 80           // hysteresis: re-arms only below 80
  },
  "conditions": [              // all must hold when the trigger fires
    { "deviceId": "<pump>", "key": "state", "op": "==", "value": "ON" }
  ],
  "actions": [
    { "kind": "command", "deviceId": "<pump>", "patch": { "state": "OFF" } }
  ],
  "cooldownSeconds": 30,
  "edgeTriggered": true
}
```

Triggers: `state` (a reading vs a comparator), `status` (online/offline, backed
by the broker's Last Will), `schedule` (minute of day + weekdays, in the home's
timezone). Actions: `command`, `delay`, `webhook`. Comparators: `> >= < <= == !=
changed truthy falsy`.

**This is what makes devices react to each other** — the trigger reads one
device, the action commands another. Water-full-stops-the-motor is the worked
example above.

**Scope is the account, not one home.** A rule may reference any device the
owner can reach, in any of their homes:

- **one device** — trigger and target are the same device ('tank is full, close
  its own valve'). Nothing else needs to exist.
- **several devices in one home** — the usual case.
- **across homes** — 'workshop tank is full, stop the house pump'.

The rule still files under a single home for listing, taken from the trigger
device so the caller never has to choose. Membership is still the boundary: a
device outside the owner's account is refused at write time, and re-checked at
every fire, so losing access to a home stops the rules that reached into it.

Four guards, because a rule loop drives real hardware:

- **Edge triggering** — fires on the false→true crossing, not on every message
  while the condition holds. On by default.
- **Hysteresis** (`clearValue`) — a latched rule re-arms only once the reading
  crosses back past a separate value, so a level sitting on 90 cannot chatter a
  relay.
- **Cooldown** — a minimum gap, claimed in Redis with `SET NX EX` so two API
  instances ingesting the same message cannot both fire.
- **Chain depth** — a rule's action tags its target; an update from that target
  inherits the depth and rules stop at 3. Without it, two rules that trigger
  each other ping-pong forever.

Conditions referencing a device that has never reported evaluate to **false** —
a rule must not act on an assumption about a silent sensor.

### Device catalogue — `/api/catalog/device-types`

Public and cacheable. 34 types across lighting, power, climate, water, security,
sensor, energy and other, each declaring the `readings` it reports (with unit,
range, enum values, firmware aliases) and the `controls` it accepts. The app
ships a generated mirror of this so it works offline, and the two are checked
for drift.

### Telemetry — `/api/devices/:id`

`GET /readings` (raw, filterable), `GET /latest`, `GET /keys`, and
`GET /series?key=temp&bucket=5 minutes` for bucketed min/max/avg — a month of
10-second telemetry is ~260k rows per key, so charts read the aggregate.

### Realtime — `/api/realtime/ws?token=<accessToken>`

WebSocket replacing the app's old direct MQTT connection. Sends
`{type:"ready",devices:[…]}` on connect, then `{type:"device.update",…}` frames
filtered to devices the user may see. `{"type":"refresh"}` re-reads visibility
after claiming a device; `{"type":"ping"}` → `pong`.

### Health

`GET /healthz` liveness (touches nothing). `GET /readyz` checks Postgres and
Redis — both required, MQTT reported but not fatal, since reads still work when
the bridge is down.

## Topic model

Home Assistant's MQTT conventions, not house rules — the same layout Tasmota,
ESPHome and Zigbee2MQTT speak, so third-party firmware and third-party hubs both
work against this broker unmodified. The app and the broker's scripts follow it
too:

```
devices/<uid>/availability  retained + LWT   "online" / "offline"
devices/<uid>/state         retained         {"state":"ON","brightness":128}
devices/<uid>/set           backend→device   {"state":"OFF"}  QoS 1, never retained
devices/<uid>/telemetry                      {"temperature":23.5,"humidity":61}
devices/<uid>/attributes    retained         extra json_attributes
devices/<uid>/<key>         retained         a single scalar reading

homeassistant/<component>/<uid>/config       retained, published by the device
```

Vocabulary follows the same source: `state` is `"ON"`/`"OFF"`, `brightness` is
0-255, `position` is 0-100, `power` means watts and `energy` kWh, and sensors
carry a `device_class`. See `src/model/deviceTypes.ts`.

Ingest rules that matter:

- **Devices announce themselves.** A retained config on the discovery prefix
  tells the backend a device's component, device class and topics; the type it
  implies fills an unset `type` but never overwrites the owner's choice. The
  device publishes it, not the backend — one retained publisher per topic, and
  it works before anyone claims the device.
- **Old names still parse.** `status`, `meta` and `cmd` map onto
  `availability`, `attributes` and `command`, and firmware reporting `temp`,
  `lux` or `power: "on"` is folded onto `temperature`, `illuminance` and
  `state` by `canonicalKey`. Nothing in the field breaks.
- **Retained messages are not history.** They are the broker replaying what it
  already held, so they update current state but are never appended to
  `device_readings` — otherwise every reconnect fabricates a data point.
- **Presence follows the Last Will.** An explicit availability topic wins;
  otherwise presence is inferred from live traffic and goes `stale` after
  `DEVICE_STALE_SECONDS`.
- **An empty retained payload clears the value**, per MQTT convention.
- An availability payload that is not a presence word (`"ON"`) is kept as a
  *reading* rather than discarded.

## Device provisioning

Claiming a device in the API generates its broker password and returns it once.
The broker reads `users.json`/`acl.json` from disk, so it still needs the
principal created there:

```bash
ssh root@143.110.177.185
cd /var/www/lumen-iot/secrets
node ../scripts/add-device.mjs esp32-01
systemctl restart lumen-iot
```

The hash format matches, so the API's generated credential can be dropped into
`users.json` directly instead of using the generated one.

## Security notes

- Passwords: scrypt N=16384, per-password salt, constant-time compare.
- Access tokens are short-lived (15 min default); refresh tokens are opaque,
  stored hashed in Redis, and **rotate on every use** — replaying a rotated
  token revokes the entire token family.
- Login is throttled per account (not just per IP) and answers identically for
  "no such user" and "wrong password", including burning equivalent CPU, so it
  cannot be used to enumerate addresses.
- `forgot-password` always returns the same response for the same reason.
- Password change and reset revoke every existing session.
- Config refuses to boot in production with the sample `JWT_SECRET` or `CORS_ORIGINS=*`.
- Authorisation funnels through one place: a row is reachable only via the home
  that owns it. Non-members get 404, not 403, so home ids cannot be probed.
- Rate limiting and Redis both degrade **open** rather than taking the API down.

## Layout

```
migrations/          forward-only SQL, applied once each in filename order
src/
  config.ts          every env var, validated at boot
  app.ts main.ts     Fastify wiring, graceful shutdown
  db/                pool, transactions, migration runner, seed
  redis/             three connections: commands, publish, subscribe
  auth/              scrypt, JWT + refresh rotation, route guards
  mqtt/              topic parsing + the broker bridge (ingest & commands)
  realtime/          WebSocket fan-out
  routes/            auth, profile, homes, devices, telemetry, health
  services/          audit log, telemetry retention sweep
tests/               unit tests for the pure logic
```

## Migrating the app

The app currently talks MQTT directly. To move it over: swap `MqttProvider` for
an API client (`/api/auth/login` → store tokens → `/api/devices`), point the
live-update layer at `/api/realtime/ws`, and send commands with
`POST /api/devices/:id/commands`. The device/reading shapes were kept close to
the app's existing view model to keep that change small. Remove the broker
password from `src/config.js` at the same time — that is the whole point.
# Lumen-Backend
