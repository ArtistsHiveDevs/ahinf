# HIVE Architecture

This document describes the architecture of the HIVE platform: the backend API (`ah-mock-api`) and the frontend app (`frontReact`). Use it as the reference for writing new code that follows the existing conventions.

---

## Backend — `ah-mock-api`

### Tech stack

| Concern | Technology |
|---|---|
| Framework | Express.js 4.x (Node.js) |
| Database | MongoDB with Mongoose ODM |
| Auth | JWT (`jsonwebtoken`) + `bcryptjs` |
| Email | AWS SES (v2) + Nodemailer |
| Config | `dotenv` |
| Utilities | Lodash |
| Dev server | Nodemon |

### Entry point flow (`server.js`)

1. **Middleware setup** — CORS (origin validation via `allowedOrigins` env var), body-parser JSON.
2. **Auth route** — `POST /api/generate-key` validates credentials (password or AWS Cognito sub) and issues a JWT with 10h expiry.
3. **Dynamic route registration** — `loadRoutes()` returns `{ path, route.router }` entries; all routers registered with `app.use(path, route)`.
4. **Global error handling** — URIError middleware; uncaught exceptions / unhandled rejections logged without crashing.
5. **Listen** — `process.env.PORT || 3001`.

**Middleware chain per request:** `validateEnvironment` (checks `x-env` header) → optional `validateApiKey` (verifies JWT, attaches `req.user` / `req.userId`) → route handler.

### Layer flow

```
Route → Operation Router → CRUD Actions (or custom handler) → Mongoose Model → MongoDB
```

### Folder responsibilities

| Folder | Responsibility |
|---|---|
| `routes/` | Route registry; maps paths to operation routers |
| `operations/` | Domain (`domain/{entity}/router.js`) and parametric routers; delegate to CRUD actions or custom handlers |
| `models/` | Mongoose schemas: `appbase/` (core, e.g. User), `domain/` (Artist, Event, Prebooking), `parametrics/geo/` (Country, Language) |
| `helpers/` | Reusable functions: CRUD actions, middleware, translations, email, API response helpers |
| `constants/` | Error codes, text constants |
| `infrastructure/` | NotificationService (multi-channel: email, push, SMS, WebSocket) |
| `db/` | DB connection, env-header encryption/decryption, model initialization |
| `rehearsal_rooms/` | Legacy router for rehearsal room entities (parallel structure to `operations/`) |
| `scripts/` | One-off utilities (DB fixes, email tests) |

### Route conventions

- One router file per entity: `operations/domain/{entity}/router.js`, exporting an **array of router instances**.
- Paths defined in a sibling `routes.constants.js` (e.g. `"/", "/:artistId", "/create", "/update/:id", "/delete/:identifier"`).
- Simple CRUD → use `createCRUDRoutes()` helper (auto-generates GET/POST/PUT/DELETE).
- Complex logic → manual router with custom handlers, inline query building, relationship population.
- Middlewares come from centralized factories: `getBaseMiddlewares`, `getActionContextMiddlewares`, `getWriteMiddlewares`.

```javascript
// operations/domain/artists/router.js
artistRouter.get(
  routesConstants.artistsList,
  ...baseMiddlewares,
  async (req, res) => {
    const { page = 1, limit = 50, fields } = req.query;
    try {
      const Artist = await getModel(req.serverEnvironment, "Artist");
      const artists = await Artist.aggregate([
        { $sample: { size: Number(limit) } },
        { $project: projection },
      ]);
      res.json(createPaginatedDataResponse(artists.slice(0, limit), page, Math.ceil(artists.length / limit)));
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);
```

### Operations / business logic layer

`helpers/crud-actions.js` exports async functions: `listEntities()`, `findEntityById()`, `createEntity()`, `updateEntity()`.

- Options-driven: `{ page, limit, fields, public_fields, postScriptFunction, filters }`.
- Handles projection, sorting, pagination, and `populate` of foreign-key references.
- `postScriptFunction` enriches/transforms results (computed fields, etc.).
- Custom actions can be added via `options.actions` (e.g. `setStatus` for prebookings, which updates participant status and triggers notifications).

```javascript
// helpers/crud-routes.js
router.get(routesConstants.artistsList, ...baseMiddlewares, async (req, res) => {
  const modelActions = await createCRUDActions({ modelName, schema, options, req });
  const response = await modelActions.listEntities({
    page: req.query.page,
    limit: req.query.limit || 50,
    fields: req.query.fields,
    public_fields: options.public_fields,
    postScriptFunction: options.postScriptFunction,
  });
  res.json(response);
});
```

### Models

- File naming: PascalCase — `Artist.schema.js`. Export pattern: `module.exports = { Artist, schema }`.
- Field naming: **snake_case** (`verified_status`, `profile_pic`).
- Refs use model name strings: `{ type: Schema.Types.ObjectId, ref: "Country" }`.
- Nested sub-schemas for structured data; `i18n: Map` for translated fields; virtuals for computed counts (e.g. `followersCount`).
- No schema hooks — business logic lives in the operations layer, not pre/post middleware.
- Models are retrieved per environment: `await getModel(req.serverEnvironment, "Artist")`.

```javascript
// models/domain/Artist.schema.js
const schema = new mongoose.Schema({
  name: { type: String, required: true },
  username: { type: String },
  verified_status: { type: Number, default: 0 },
  country: { type: Schema.Types.ObjectId, ref: "Country" },
  genres: { music: [String] },
}, { timestamps: true });

const Artist = mongoose.model("Artist", schema);
module.exports = { Artist, schema };
```

### Error handling & response format

Standardized via `helpers/apiHelperFunctions.js`:

```javascript
createPaginatedDataResponse(data, currentPage = 1, totalPages = 1)
// → { data, currentPage, totalPages }

createAPIErrorResponse(message, errorCode, errorNumber)
// → { message, errorCode, errorNumber }
```

- Error codes are centralized enums in `constants/errors.js` (`AUTH_INVALID_CREDENTIALS`, `CONTENT_NOT_FOUND`, `AUTH_PERMISSION_DENIED`, ...).
- Status codes: 200 success, 201 created, 400 bad input, 401 auth failure, 404 not found, 500 server error.

```javascript
if (!identifier) {
  return res.status(400).send({
    message: "User identifier is required (username, email, userId, or identifier).",
    errorCode: ErrorCodes.AUTH_NO_USER_PROVIDED,
  });
}
```

### Auth & roles

- JWT flow: `POST /api/generate-key` → `bcrypt.compare()` → `jwt.sign({ id: user._id }, SECRET_KEY, { expiresIn: "10h" })` → `{ apiKey: token }`.
- Protected routes use `validateApiKey` middleware.
- Multi-entity roles on the User model:

```javascript
roles: [{
  entityName: "Artist",
  entityRoleMap: [{ id: artistId, roles: ["OWNER", "ADMIN", "PHOTOGRAPHER"] }]
}]
```

### Entity Directory & profile identity resolution

`models/appbase/EntityDirectory.js` is a **cross-entity index** (User/Artist/Place) used to resolve a "profile identifier" (username, shortId, or ObjectId) to the underlying entity, via `normalizeProfileId(id, connection)`. It backs:

- `req.user.currentProfileIdentifier` resolution on every generic list request (`helpers/crud-actions.js:listEntities()`), used to build `sameProfile`/`sameUser` filters (see `processFilters()`).
- Cross-entity search/lookup (`normalizeProfileId` is also used by Prebooking flows, etc).

**Hard rule: every Artist, Place, and User creation MUST create a matching `EntityDirectory` record.** `modelRequiresEntityIndex(modelName)` (`crud-actions.js`) returns `true` for exactly `["Artist", "Place", "User"]`. Use the shared helper — never duplicate the location/search_cache logic inline:

```javascript
const { createEntityDirectoryRecord } = require("../../models/appbase/EntityDirectory");

await createEntityDirectoryRecord({
  entityInfo,       // { id, shortId, profile_pic, name, username, subtitle, verified_status, approval_status }
  modelName,         // "Artist" | "Place" | "User"
  newEntity,         // the just-saved Mongoose document
  countryName,       // optional, not stored on the entity itself
  EntityDirectoryModel,
});
```

`helpers/crud-actions.js:createEntity()` calls this automatically for any entity that goes through the generic CRUD path. **Pitfall found in production: a hand-written router that reimplements creation (e.g. a manual `POST /artists` that duplicates the `entityRoleMap`/ownership logic instead of using `createEntity()`) is easy to get "mostly right" while silently skipping this step** — the entity saves fine and looks fully functional until that profile becomes the user's *active* profile and hits any generic list endpoint, which crashes with `EntityDirectory not found for identifier: <username>`. Any manual router that duplicates `createEntity()`'s logic must call `createEntityDirectoryRecord()` too, or better: don't duplicate the logic — use `createEntity()` / the shared helper.

**Fail-closed on resolution failure.** `listEntities()` wraps both `normalizeProfileId()` calls (for `currentProfileIdentifier` and `user.id`) in try/catch. If resolution fails for a profile referenced by a `filters` entry with `compareWith: "sameProfile"` or `"sameUser"`, the whole list call returns an **empty result** rather than either (a) crashing the endpoint, or (b) silently returning the list *unfiltered* (which would leak other users'/profiles' data). Follow this same fail-closed convention for any new code that conditionally filters by resolved identity.

### Denormalized counters

Some entities carry a denormalized counter derived from another collection (e.g. `OpenCall.applications_count`, counting `OpenCallApplication` documents). **Mongoose does not maintain these automatically** — a field with `default: 0` just stays 0 forever unless something increments it. Wire the increment via `options.postCreateFunction` on the route that creates the *related* entity:

```javascript
// routes/routes.js — /open-call-applications create options
postCreateFunction: async ({ entity, req }) => {
  const OpenCallModel = await getModel(req.connection.environment, "OpenCall");
  await OpenCallModel.findByIdAndUpdate(entity.open_call_id, {
    $inc: { applications_count: 1 },
  });
},
```

There is currently **no `postDeleteFunction` hook** — if a delete flow is ever added for an entity that feeds a counter like this, the counter needs a matching decrement added deliberately (the hook infrastructure doesn't exist yet). If you add or fix a denormalized counter and existing data predates the fix, write a one-off backfill script (see below) to recompute it from the real source collection — don't assume old records self-heal.

### Local dev environment & one-off scripts

- Dev Mongo runs via Docker (`ahinf/docker-compose.yml`), exposed on host port `27017`. `MONGO_URI_DEV` in `.env` uses the Docker-internal hostname `mongo` (`mongodb://admin:devpassword@mongo:27017/...`), which **only resolves from inside the compose network** (i.e. from the `backend` container). A script run from the host (not inside Docker) must substitute `mongo` → `localhost` in the URI (same credentials, same port).
- One-off maintenance/migration scripts live in `scripts/`, follow the `node scripts/xxx.js --env=dev|uat|prod [--dry-run]` convention, connect with `mongoose.createConnection(uri)`, and should be **idempotent** (safe to run twice — check "does this already have the fix applied" before writing).
- After a code change to a route/model, restart the backend container (`docker restart ah_backend`) to pick it up — it's bind-mounted, no rebuild needed, but nodemon doesn't always catch every change.

### Naming & async conventions

- Files: camelCase (`apiHelperFunctions.js`) or hyphenated (`crud-routes.js`); schemas PascalCase.
- Functions: camelCase. Constants: UPPER_CASE.
- **100% async/await** — no callbacks. `Promise.all()` for parallel operations.

### Known data-model gap: multiple roles per user within one Artist/Place

`User.roles[].entityRoleMap[]` (the snapshot on the **User** side) stores `roles: [String]` — a real array, already designed to support multiple simultaneous roles (e.g. `["OWNER", "PHOTOGRAPHER"]`) for the same entity. But `Artist.entityRoleMap[]` / `Place.entityRoleMap[]` (the **entity's own** side) stores `role: String` — singular, one role per array entry. There is no code path today that adds a second role for a user already present in an Artist/Place's `entityRoleMap`, and no endpoint to invite/add a member to an existing Artist/Place at all (creation only sets a single `OWNER` entry). If you're asked to build multi-role band membership or a "add member" flow, this asymmetry is the first thing to resolve — don't assume the array shape already supports it.

---

## Frontend — `frontReact`

### Tech stack

| Concern | Technology |
|---|---|
| Framework | React 18 (functional components + hooks, StrictMode) |
| Build | Vite (TypeScript + SWC) |
| State | Redux Toolkit + Redux-Saga, dynamic injection via `redux-injectors` |
| UI | Material-UI 5, Bootstrap 5, Mantine 7 |
| Styling | SCSS (per-component `.scss`, shared tokens in `variables.module.scss`), Emotion |
| i18n | react-intl (8 languages) |
| Routing | React Router DOM v6, config-driven |
| HTTP | Native `fetch` via custom wrapper (`src/common/utils/request/`) |
| Forms | React Hook Form |
| Server cache | React Query (partial usage) |
| Native | Capacitor 4 (Android/iOS) |
| Cloud | AWS Amplify 6 (Cognito auth, S3 storage) |
| Dates | Dayjs (MUI adapter), date-fns |

### Entry point flow

```
main.tsx
  ├─ Configures AWS Amplify (Cognito + S3, local Cognito fallback)
  ├─ Creates Redux store (saga middleware + redux-injectors enhancer)
  └─ <Provider store>
App.tsx
  ├─ ThemeProvider (MUI dark theme)
  ├─ HelmetProvider
  ├─ HvAppContextProvider (language / i18n messages)
  ├─ BrowserRouter
  ├─ AuthProvider (Cognito auth checks)
  ├─ IntlProvider (react-intl)
  ├─ LocalizationProvider (MUI + Dayjs)
  └─ <Suspense fallback={<AppLoader />}><RoutesApp /></Suspense>
```

### Folder responsibilities (`src/`)

| Folder | Purpose |
|---|---|
| `components/` | UI components by domain: `Pages/` and `shared/` (atoms → molecules → organisms) |
| `routes/` | `ROUTES_CONFIG` + `RoutesApp` component (auth-based redirects) |
| `store/` | `configureStore.ts` + `root-reducer.ts` (dynamic reducer injection) |
| `common/` | `slices/` (Redux domain logic), `hooks/`, `utils/` (request, auth, analytics), `context/`, react-query helpers |
| `models/` | TS entity models: `base/` abstract classes, `domain/` business entities; S3 URL caching, field transforms |
| `constants/` | Enums/constants: routes (PATHS), errors, domain, localStorage keys |
| `translations/` | Per-language message dictionaries, flattened to dot notation for react-intl |

### Component conventions

- Functional components only; props typed with inline object types or interfaces.
- One folder per component: `ComponentName/` with `ComponentName.tsx` + `ComponentName.scss` + `index.tsx` re-export.
- SCSS imports shared tokens from `variables.module.scss`.

```typescript
// src/components/shared/atoms/Title/Title.tsx
export const Title = (props: { title: string; size: '1' | '2' | '3' | '4' | '5'; onClickHandler: Function }) => {
  const { title, size, onClickHandler } = props;
  switch (size) {
    case '1': return <h1 onClick={() => onClick(title)}>{title}</h1>;
    // ...
  }
};
```

### Dynamic pages — `PageSection[]` config system

Entity detail/edit pages (Artist, Event, Place, Rider, User, Academy, Prebooking, Tour, OpenCall...) are **not hand-laid-out JSX**: they're declared as a `PageSection[]` config tree consumed by two generic renderers — one read-only, one for create/edit. This is the central pattern for this kind of page in the repo; a new entity page should reuse it, not maquette JSX ad-hoc.

- **Schema** (`components/shared/organisms/gui/builders/component-types.def.tsx`): `PageSection` (a tab) → `ContentSection` (a section within the tab) → `ComponentDescriptor` (a visual block, `componentName: ComponentTypes`) → `AttributeConfiguration` (a field, `{ name, title?, value?, formMetaData? }`). `FormMetadata = { inputType?, fieldName?, config?: RegisterOptions, defaultValue?, hidden? }` is what lets the *same* `AttributeConfiguration` drive both the read-only view and a form input.
- **Builders** (`.../builders/componentBuilders/`): each `ComponentTypes` maps to a builder function registered in `BUILDER_CONFIG`. A new visual block = new enum value + new builder file + one line in `BUILDER_CONFIG` — never a conditional inside an existing builder.
- **Read-only renderer**: `ProfileTabsPage` → `TabbedPanel`, walks `PageSection → ContentSection → ComponentDescriptor` and calls `buildComponentFromRegistry`.
- **Edit/create renderer**: `DynamicTabbedForm` consumes the **same** `PageSection[]`, converts each `AttributeConfiguration.formMetaData` into a `DynamicFieldData`, and renders it via `DynamicControl` (react-hook-form).
- One config file (`config-{entity}-detail.tsx`) feeds both the detail page and the create/edit page for that entity — e.g. `ArtistDetails/index.tsx` and `ArtistCreatePage.tsx` both import `ARTIST_DETAIL_SUB_PAGE_CONFIG`. Multi-step wizards (Open Call apply/create) reuse the same `PageSection[]` shape per-step, with local `currentStep` state and `trigger(getFieldNamesFromPageSection(steps[currentStep]))` to validate one step at a time.

### Dynamic form field components — required config defaults

Every component in `dynamicForms/components/` (`TextField`, `TextArea`, `Select`, `ChipPicker`, `AutocompletePicker`, `FileUpload`, `Radio`, `Checkbox`, `Switch`, `RelationshipSelector`, ...) receives `fieldData.config` from `AttributeConfiguration.formMetaData.config`, and **`config` is frequently `undefined`** — most configs only set it for fields that need validation rules. Two conventions, both found broken and fixed in production:

1. **Always default `config` to `{}` at destructure**: `const { config = {} } = fieldData` (or `config = config || {}` right after). A component that writes `config.value = x` without this default throws on render for any field that omits `config` — and because there is **no React error boundary anywhere in this app**, that one field crashes the *entire page* to a blank white screen, not just that field.
2. **`config.required` is idiomatically a validation message string** (react-hook-form convention: `required: 'Este campo es obligatorio'`), not a boolean. Deriving the visual required-asterisk (or any other "is this required" branch) must use `!!config.required` (truthy check) — **never** `required === true || required === 'true'` (strict equality against the literal `true`), which is always `false` for a message string and silently hides the asterisk / skips the rule while the *actual* react-hook-form validation still enforces it. This exact bug existed in six components at once (`TextField`, `TextArea`, `Select`, `Radio`, `Checkbox`, `RelationshipSelector`) and, worst case, in `Switch` it disabled the real validation rule too (not just the visual indicator), because `Switch` builds its own `rules.required` from that same broken comparison instead of passing `config` through to `register()`.

### AWS Amplify `<Authenticator>` — custom tabs

The built-in Sign In/Create Account tab switcher rendered by `<Authenticator>` (`SignInSignUpTabs` inside `@aws-amplify/ui-react`) has a library bug: its `onValueChange` ignores which tab was actually clicked and just flips the current route, so clicking the already-active tab (or, functionally, any click in that row) can toggle to the other tab. Don't patch `node_modules`. Instead: wrap both a custom tabs component and `<Authenticator>` in a single `<Authenticator.Provider>` (nesting is safe — a second internal provider created by `<Authenticator>` detects the parent and reuses its context/state machine instead of creating a new one), read `route`/`toSignIn`/`toSignUp` via `useAuthenticator()` in the custom component, and hide the native tab list with `[data-amplify-router] .amplify-tabs__list { display: none }` scoped to that page.

### State management

- **Generic entity slices**: `generic-slice.ts` / `generic-selector.ts` in `src/common/slices/` provide reusable CRUD state (`items`, `loading`, `error`, `detailedItems`).
- Slices organized by domain: `slices/app-base/`, `slices/domain/`, `slices/parametrics/`.
- Each slice may have a saga (`takeLatest`) for API side effects.
- **Dynamic injection**: components mount the reducer/saga via a `useXxxSlice()` hook.
- Selectors use reselect `createSelector` (`selectItems`, `selectLoading`, `selectError`).

```typescript
// src/common/slices/domain/artists/artist.redux.ts
const { slice: artistSlice, saga: sagaArtists } = createEntitySlice({
  name: 'artists',
  Model: ArtistModel,
  initialState: { items: [], loading: false, error: null, detailedItems: {} },
  resourceEndpoint: '/artists',
  selectors: { ...selectorArtists },
});

export const useArtistsSlice = () => {
  useInjectReducer({ key: artistSlice.name, reducer: artistSlice.reducer });
  useInjectSaga({ key: artistSlice.name, saga: sagaArtists });
  return { actions: artistSlice.actions };
};
```

```typescript
// Consumption in a component (src/components/Pages/HomePage/MainHome/index.tsx)
const HomePage = () => {
  const artistList: ArtistModel[] = useSelector(selectorArtists.selectItems);
  const { actions: artistsActions } = useArtistsSlice();
  const dispatch = useDispatch();

  useEffect(() => {
    dispatch(artistsActions.loadItems({}));
  }, []);

  return <MainSection artists={artistList} />;
};
```

### Routing

- Config-driven: hierarchical `ROUTES_CONFIG` object; `RoutesApp` flattens it and generates `<Route>` elements.
- Auth guards per route: `redirectToIfLoggedUser` / `redirectToIfNotLoggedUser`; supports `?next=` post-login redirect.
- Route paths centralized in `src/constants/routes.constants.ts` (PATHS enum).
- Lazy loading via `Suspense` + `AppLoader`.

### API calls

- Custom fetch wrapper in `src/common/utils/request/index.ts`: `request()`, `postRequest()`, `putRequest()`, `patchRequest()`, `deleteRequest()`.
- Every request carries the `x-env` header (AES-encrypted environment key); pre-auth endpoints use `generatePreAuthHeaders()` (`x-req-ctx`).
- Errors wrapped in a custom `ResponseError` class.
- Backend base URL: `import.meta.env.VITE_ARTISTS_HIVE_SERVER_URL`.
- API calls live in **sagas**, not components:

```typescript
// src/common/slices/app-base/APIKey/saga.ts
function* getApiKey(actionParams?: PayloadAction<ApiKeyPayload>) {
  const { username, sub } = actionParams?.payload || {};
  const requestURL = `${import.meta.env.VITE_ARTISTS_HIVE_SERVER_URL}/api/generate-key`;
  try {
    const response = yield call(postRequest, requestURL, { body: JSON.stringify({ username, sub }) });
    yield put(actions.apiKeyLoaded(response));
  } catch (err) {
    const errorContent = yield call(() => (err as ResponseError).content);
    yield put(actions.repoError({ errorType: ApiKeyErrorType.RESPONSE_ERROR, error: errorContent }));
  }
}
```

### Navigating after a create action

The generic create saga (`generic-slice.ts`) dispatches `itemCreated(response.data)` — populating `selectorXxx.selectCreatedItem` — **immediately** after the POST resolves. Separately, if the entity type is in `AVAILABLE_ENTITY_MEMBERSHIPS`, it also dispatches `usersActions.switchProfile({ id })`, which is a **much slower** multi-step roundtrip (`delay(500)` → `PUT /users/:id` → `delay(300)` → `loadCurrentUser()` → `GET /me`) that eventually updates `loggedUser.currentProfileIdentifier`/`currentProfileInfo`. **Do not gate a "navigate to the thing I just created" effect on `loggedUser.currentProfileIdentifier`** — it's stale (still the previous active profile) for the whole duration of that roundtrip, and a `useEffect` keyed on it fires with the *old* value first, navigating to the wrong (or a nonexistent) profile. Use the creation saga's own `createdItem` (via `selectorXxx.selectCreatedItem`) instead — it's correct immediately and doesn't depend on the `switchProfile` roundtrip completing.

### i18n

- Files: `src/translations/{lang}.ts` (en, es, de, fr, it, pt, el, es-co); nested objects flattened to dot notation (`"app.pages.HomePage.title"`).
- Registered in an `appMessages` map keyed by language code; provided via `IntlProvider`.
- Usage: `const { translateText } = useI18n(); translateText('app.pages.HomePage.title');`
- No hardcoded user-facing strings — always add translation keys.

### TypeScript conventions

- Prefer **interfaces** for object shapes / domain entities.
- Template pattern: each entity has a `*Template` interface matching the API response shape; hierarchy `EntityTemplate → ProfileTemplate → specific entities`.
- Domain models extend an abstract `Model<T>` / `EntityModel<Template>` base (e.g. `ArtistModel extends EntityModel<ArtistTemplate>`), handling S3 URL caching, field transformations, and type coercion.
- Enums for statuses (e.g. `PreBookingRequestStatus`).

---

## Checklist: adding a new feature

### New backend endpoint (entity)

1. Create schema: `models/domain/{Entity}.schema.js` (snake_case fields, `module.exports = { Entity, schema }`).
2. Register model in `db/` model initialization.
3. Create `operations/domain/{entity}/routes.constants.js` with path constants.
4. Create `operations/domain/{entity}/router.js` — use `createCRUDRoutes()` for standard CRUD, custom handlers for the rest; apply the appropriate middleware factories.
5. Register the router in `routes/`.
6. Use `createPaginatedDataResponse` / `createAPIErrorResponse` and codes from `constants/errors.js`.

### New frontend entity/page

1. Add `*Template` interface and `Model` class in `src/models/domain/`.
2. Create slice with `createEntitySlice` in `src/common/slices/domain/{entity}/` + `useXxxSlice()` hook (+ saga if custom API behavior needed).
3. Add selectors (generic selectors usually suffice).
4. Create page component under `src/components/Pages/{Page}/` (folder + `.tsx` + `.scss` + `index.tsx`).
5. Add path to `src/constants/routes.constants.ts` and register in `ROUTES_CONFIG` (with auth guards if needed).
6. Add translation keys to **all** files in `src/translations/`.

## Anti-patterns to avoid

- Business logic in Express route handlers (belongs in operations/CRUD actions or `postScriptFunction`).
- Direct `fetch` calls in React components (use the request wrapper inside sagas).
- Hardcoded user-facing strings (use react-intl translation keys).
- Ad-hoc API response shapes (use the paginated/error response helpers).
- Class components or callback-style async code.
- camelCase Mongo field names (backend fields are snake_case).
- Creating an Artist/Place/User (especially via a hand-written router instead of `createEntity()`) without also creating its `EntityDirectory` record — crashes any generic list endpoint later, once that profile becomes active (see "Entity Directory & profile identity resolution").
- Adding a denormalized counter field (`*_count`) without a `postCreateFunction` (and, if deletion exists, an equivalent decrement) to keep it in sync — it will silently sit at its default forever.
- In `dynamicForms/components/*`, destructuring `config` from `fieldData` without defaulting to `{}`, or checking `required === true || required === 'true'` instead of `!!config.required` — both are real bugs found and fixed in production (blank-page crash and invisible/unenforced required fields, respectively).
- Gating a "navigate to what I just created" effect on `loggedUser.currentProfileIdentifier` instead of the creation saga's own `createdItem` — the former lags behind an async `switchProfile` roundtrip and fires with the stale value first.
