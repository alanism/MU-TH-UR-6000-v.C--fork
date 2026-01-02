Below is concise but complete product documentation for App C (MU-TH-UR 6000 – Field Telemetry), written so it works for:
	•	MSF program directors (what / why)
	•	Technical reviewers (how / constraints)
	•	Future contributors (architecture + file roles)

I’ve kept it MECE, offline-first, and authoritative, without drifting into marketing or speculation.

⸻

:::writing{id=“68412” variant=“document”}

MU-TH-UR 6000 — Field Telemetry (App C)

Version: C (Field-Hardened, CSP-Safe)
Audience: Doctors Without Borders (MSF) Program Directors, Field Ops Leads, Technical Auditors
Operating Context: Offline, low-bandwidth, high-stress environments

⸻

1. What This App Is (and Is Not)

What it is

MU-TH-UR 6000 is a read-only, browser-native telemetry console for reviewing operational signals derived from exported EMR SQLite databases.

It helps field leadership see patterns in care delivery without:
	•	modifying records
	•	uploading data
	•	requiring connectivity
	•	relying on opaque analytics or AI interpretation

What it is not
	•	❌ Not an EMR
	•	❌ Not a clinical decision system
	•	❌ Not an AI advisor
	•	❌ Not a dashboard with alerts, thresholds, or prescriptions

This tool is descriptive, not prescriptive.

⸻

2. Primary Use Case (Field Reality)

Who uses it
	•	MSF program directors
	•	Medical coordinators
	•	Operations leads
	•	Field IT staff supporting leadership

When it is used
	•	During periodic program reviews
	•	In low-connectivity or disconnected settings
	•	On shared or secured field laptops

Typical flow
	1.	Export a SQLite (.db) file from the local EMR system
	2.	Open MU-TH-UR 6000 in a browser (no login, no network)
	3.	Load the EMR export
	4.	Review aggregate telemetry:
	•	patient visit volume
	•	visit duration
	•	workflow states
	•	staff workload distribution
	5.	Close the browser — no data persists

⸻

3. Core Design Principles (Why It’s Built This Way)

3.1 Offline-First by Default

Field conditions are unpredictable.
The app must function with zero internet, once assets are present.

Result:
All processing, rendering, and validation happen locally in the browser.

⸻

3.2 Data Never Leaves the Device

Trust is non-negotiable in humanitarian contexts.

Guarantees:
	•	No backend
	•	No API calls
	•	No telemetry or analytics
	•	No logging of uploaded data
	•	No persistence after refresh

⸻

3.3 Deterministic & Auditable

Two people loading the same file see the same results.

No:
	•	hidden heuristics
	•	stochastic analysis
	•	black-box AI inference

Everything is:
	•	explicit
	•	inspectable
	•	repeatable

⸻

3.4 Descriptive, Not Prescriptive

The app shows signals, not judgments.

Allowed:
	•	trends
	•	comparisons
	•	distributions

Explicitly excluded:
	•	alerts
	•	thresholds
	•	“risk” labels
	•	recommendations

Interpretation remains human.

⸻

4. Telemetry: What Is Shown (and Why)

The telemetry focuses on operational load and flow, not individual patients.

4.1 Patient Visits Over Time

What it shows:
Aggregate visit volume by time bucket.

Why:
Helps identify surges, drops, and cadence changes without exposing patient data.

⸻

4.2 Average Visit Duration

What it shows:
Mean duration of visits over time.

Why:
Acts as a proxy for workflow pressure and complexity without assigning blame.

⸻

4.3 Workflow Status

What it shows:
Distribution of visits across system states (e.g., registered, in-progress, completed).

Why:
Reveals bottlenecks and backlog patterns.

⸻

4.4 Staff Workload by Role

What it shows:
Relative distribution of activity across staff roles or operators.

Why:
Supports staffing conversations without individual performance scoring.

⸻

4.5 Communication / Event Volume

What it shows:
Counts of logged events or actions over time.

Why:
Provides a sense of system “chatter” and operational tempo.

⸻

5. File Lifecycle Transparency (Field Safety)

The app uses an explicit state machine so users always know what is happening.

States
	•	IDLE – waiting for input
	•	RECEIVED – file acknowledged by browser
	•	PROCESSING – local analysis underway
	•	VALID – telemetry successfully loaded
	•	INVALID – file rejected with explanation

No fake progress bars.
No silent failures.

⸻

6. Architecture Overview (High Level)

SQLite (.db file)
      ↓
Browser File API
      ↓
Web Worker (telemetry-worker.js)
      ↓
sql.js (WASM)
      ↓
Fixed SQL Aggregations
      ↓
Aggregated Results Only
      ↓
D3 Visual Rendering (app.js)

Key property:
Raw database rows never touch the main UI thread.

⸻

7. Codebase Structure (5 Files)

7.1 index.html

Role:
Static HTML shell and layout.

Responsibilities:
	•	Defines UI structure and panels
	•	Enforces strict CSP
	•	Declares offline-safe assets
	•	Hosts file input and overlays
	•	No inline scripts
	•	No dynamic injection

⸻

7.2 app.js

Role:
Single application entrypoint and UI controller.

Responsibilities:
	•	App initialization
	•	Deterministic synthetic demo data on boot
	•	File lifecycle state machine
	•	Worker communication
	•	D3 chart rendering (join pattern)
	•	Status and overlay updates
	•	Accessibility and field-mode toggles

⸻

7.3 telemetry-worker.js

Role:
Isolated data processing engine.

Responsibilities:
	•	Load sql.js WASM safely
	•	Validate schema defensively
	•	Run fixed aggregation queries
	•	Normalize timestamps
	•	Enforce file size limits
	•	Prevent concurrent jobs
	•	Return aggregated results only
	•	Close database cleanly on every run

⸻

7.4 sql-wasm.js

Role:
JavaScript loader for SQLite compiled to WebAssembly.

Why included locally:
	•	CSP-safe
	•	No eval
	•	No network dependency
	•	Auditable version lock

⸻

7.5 sql-wasm.wasm

Role:
The SQLite engine itself (compiled to WASM).

Why WASM:
	•	Runs natively in the browser
	•	Fast, deterministic
	•	No server dependency
	•	Memory-isolated

⸻

8. Security & Compliance Notes
	•	Strict Content Security Policy (no unsafe-eval)
	•	No inline scripts or styles
	•	No external CDNs
	•	Worker isolation for untrusted data
	•	No persistence (refresh clears state)
	•	Designed for auditability

⸻

9. Known Limitations (By Design)
	•	Not a replacement for EMR reporting
	•	No record-level inspection
	•	No exports or sharing
	•	No multi-file comparison
	•	No live updates

These are intentional to preserve safety and trust.

⸻

10. Summary

MU-TH-UR 6000 (App C) is a field-hardened, offline-first telemetry instrument designed to:
	•	respect data sovereignty
	•	function under real humanitarian constraints
	•	surface operational signals without prescribing action

It is intentionally conservative, transparent, and limited —
because in this context, trust beats cleverness.

⸻

End of documentation.
:::

⸻


# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1KZKuIHk7ATWw5ZleevE3uHUSr0C3dMyx

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`
